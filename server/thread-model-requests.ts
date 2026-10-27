import type { ThreadModelRequestCardData } from "../shared/thread-model-request.ts";
import type { ModelSelection } from "../shared/wire.ts";
import { newId } from "./contracts.ts";
import { harnessCapabilityLines, type DriverCapabilities } from "./harness-capabilities.ts";
import { UNDO_STALE, type DirectApply, type DirectApplyCheck } from "./direct-apply.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BotRecord, TaskPatch, TaskRecord } from "./store.ts";

const MAX_REASON = 500;
const NO_SUCH_THREAD = "No conversation matches that thread_id — call list_threads for the ones you can see";

export interface OptionCardLike {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  autoApplied?: boolean;
  undone?: boolean;
  threadModelRequest?: ThreadModelRequestCardData;
}

export interface ThreadModelRequestStore {
  bot(id: string): BotRecord | undefined | null;
  botByThread(threadId: string): BotRecord | null;
  taskByThread(botId: string, threadId: string): TaskRecord | undefined;
  messagesFor(threadId: string): Array<{ id: string; card?: OptionCardLike }>;
  appendMessage(
    threadId: string,
    message: {
      role: "bot";
      kind: "options";
      card: OptionCardLike;
      from?: { botId: string; name: string; color: string };
    },
  ): { id: string };
  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): { id: string } | null;
  switchTaskModel(
    botId: string, threadId: string, selection: ModelSelection,
    updateBotDefault: boolean, resetApprovalToAsk: boolean, taskPatch?: TaskPatch,
  ): TaskRecord | null;
}

export type SwitchCheck =
  | { ok: true; selection: ModelSelection }
  | { ok: false; status: number; error: string };

export interface ThreadModelRequestServiceOptions {
  store: ThreadModelRequestStore;
  now?: () => number;
  autoApply?: DirectApplyCheck;
  canPersist?: (botId: string, threadId: string, opensCard: boolean) => { ok: true } | { ok: false; status: number; error: string };
  authorize: (fromBotId: string, owner: BotRecord, task: TaskRecord, sourceThreadId: string) => string | null;
  checkSwitch: (current: BotRecord, raw: unknown) => SwitchCheck;
  resetTask?: (from: ModelSelection, to: ModelSelection) => TaskPatch;
  driverCapabilities?: (instanceId: string) => DriverCapabilities | undefined;
}

export class ThreadModelRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ThreadModelRequestError";
    this.status = status;
  }
}

export type ResolveThreadModelRequestResult =
  | { claimed: false; state: "not_found" }
  | { claimed: true; state: "invalid"; error: string; status: number }
  | { claimed: true; state: "already_settled"; behavior: string }
  | { claimed: true; state: "denied" }
  | { claimed: true; state: "applied"; targetBotId: string; targetThreadId: string; settlementPending?: true; message?: string };

export type UndoThreadModelRequestResult =
  | { claimed: false }
  | { claimed: true; state: "already_undone" }
  | { claimed: true; state: "invalid"; error: string; status: number; stale?: true }
  | { claimed: true; state: "undone"; targetBotId: string; targetThreadId: string };

const sameSelection = (a: ModelSelection, b: ModelSelection) =>
  a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;

function reasonText(value: unknown): string {
  if (typeof value !== "string") throw new ThreadModelRequestError("reason is required");
  const trimmed = value.trim();
  if (!trimmed) throw new ThreadModelRequestError("reason is required");
  if (trimmed.length > MAX_REASON) throw new ThreadModelRequestError("reason must be 500 characters or fewer");
  return redactSecretsInText(trimmed);
}

export function threadModelCardCopy(args: {
  targetName: string;
  targetTitle: string;
  before: ModelSelection;
  selection: ModelSelection;
  reason: string;
  capabilityLines: string[];
}): { title: string; summary: string; detail: string } {
  const title = `Change the model of #${args.targetTitle} (@${args.targetName})?`;
  const lines = [
    `Why: ${args.reason}`,
    `Conversation: #${args.targetTitle} on @${args.targetName}`,
    `Model: ${JSON.stringify(args.before)} → ${JSON.stringify(args.selection)}`,
    "The change lands on that conversation's next turn; a turn already running keeps the model it started with.",
    "Nothing runs.",
  ];
  lines.push(...args.capabilityLines);
  return { title, summary: `${title} · conversation model`, detail: lines.join("\n") };
}

export class ThreadModelRequestService {
  private readonly store: ThreadModelRequestStore;
  private readonly now: () => number;
  private readonly autoApply?: DirectApplyCheck;
  private readonly canPersist?: ThreadModelRequestServiceOptions["canPersist"];
  private readonly authorize: ThreadModelRequestServiceOptions["authorize"];
  private readonly checkSwitch: ThreadModelRequestServiceOptions["checkSwitch"];
  private readonly resetTask?: ThreadModelRequestServiceOptions["resetTask"];
  private readonly driverCapabilities?: ThreadModelRequestServiceOptions["driverCapabilities"];

  constructor(options: ThreadModelRequestServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.autoApply = options.autoApply;
    this.canPersist = options.canPersist;
    this.authorize = options.authorize;
    this.checkSwitch = options.checkSwitch;
    this.resetTask = options.resetTask;
    this.driverCapabilities = options.driverCapabilities;
  }

  submit(args: {
    botId: string;
    threadId: string;
    targetThreadId: string;
    selection: unknown;
    reason: unknown;
    from?: { botId: string; name: string; color: string };
  }): { requestId: string; messageId: string; title: string; summary: string; detail: string; state: "applied" | "pending"; appliedBy?: DirectApply } {
    const reason = reasonText(args.reason);
    const targetThreadId = typeof args.targetThreadId === "string" ? args.targetThreadId.trim() : "";
    if (!targetThreadId) throw new ThreadModelRequestError("thread_id is required");
    const owner = this.store.botByThread(targetThreadId);
    const task = owner ? this.store.taskByThread(owner.id, targetThreadId) : undefined;
    if (!owner || !task) throw new ThreadModelRequestError(NO_SUCH_THREAD, 404);

    const refusal = this.authorize(args.botId, owner, task, args.threadId);
    if (refusal) throw new ThreadModelRequestError(refusal, 403);

    const checked = this.checkSwitch({ ...owner, threadId: targetThreadId, modelSelection: task.modelSelection ?? owner.modelSelection }, args.selection);
    if (!checked.ok) throw new ThreadModelRequestError(checked.error, checked.status);

    const before = task.modelSelection ? structuredClone(task.modelSelection) : undefined;
    const beforeDefault = structuredClone(owner.modelSelection);
    if (sameSelection(checked.selection, before ?? beforeDefault)) throw new ThreadModelRequestError("Nothing would change");

    const requestId = newId();
    const payload: ThreadModelRequestCardData = {
      version: 1,
      requestId,
      botId: args.botId,
      threadId: args.threadId,
      targetBotId: owner.id,
      targetName: redactSecretsInText(owner.name),
      targetThreadId,
      targetTitle: redactSecretsInText(task.title),
      createdAt: this.now(),
      reason,
      selection: checked.selection,
      beforeDefault,
      ...(before ? { before } : {}),
    };
    const capabilityLines = this.driverCapabilities
      ? harnessCapabilityLines(this.driverCapabilities((before ?? beforeDefault).instanceId), this.driverCapabilities(checked.selection.instanceId))
      : [];
    const copy = threadModelCardCopy({
      targetName: payload.targetName, targetTitle: payload.targetTitle,
      before: before ?? beforeDefault, selection: checked.selection, reason, capabilityLines,
    });
    const grant = this.autoApply?.(args.botId, args.threadId, owner.id) ?? null;
    const automatic = grant !== null;
    const persistence = this.canPersist?.(args.botId, args.threadId, !automatic);
    if (persistence && !persistence.ok) throw new ThreadModelRequestError(persistence.error, persistence.status);
    const messageInput: Parameters<ThreadModelRequestStore["appendMessage"]>[1] = {
      role: "bot",
      kind: "options",
      card: {
        title: copy.title,
        subtitle: copy.detail,
        options: automatic ? [] : ["Confirm", "Cancel"],
        ...(automatic ? { dismissed: true } : {}),
        requestId,
        tool: "set_thread_model",
        threadModelRequest: payload,
      },
    };
    if (args.from) messageInput.from = args.from;
    const message = this.store.appendMessage(args.threadId, messageInput);
    const proposal = { requestId, messageId: message.id, title: copy.title, summary: copy.summary, detail: copy.detail };
    if (!automatic) return { ...proposal, state: "pending" as const };
    const result = this.resolve({ botId: args.botId, threadId: args.threadId, requestId, behavior: "allow" });
    if (result.state === "applied") {
      if (!result.settlementPending) this.recordAutoApplied(args.threadId, message.id);
      return { ...proposal, state: "applied" as const, appliedBy: grant! };
    }
    throw new ThreadModelRequestError(result.state === "invalid" ? result.error : "The model change could not be applied", result.state === "invalid" ? result.status : 409);
  }

  private recordAutoApplied(threadId: string, messageId: string): void {
    try {
      const card = this.store.messagesFor(threadId).find((candidate) => candidate.id === messageId)?.card;
      if (card?.threadModelRequest) this.store.patchMessage(threadId, messageId, { card: { ...card, autoApplied: true } });
    } catch {
    }
  }

  private apply(payload: ThreadModelRequestCardData): void {
    const switched = this.store.switchTaskModel(
      payload.targetBotId, payload.targetThreadId, payload.selection, false, false,
      this.resetTask ? this.resetTask(payload.before ?? payload.beforeDefault, payload.selection) : {},
    );
    if (!switched) throw new ThreadModelRequestError(NO_SUCH_THREAD, 404);
  }

  undo(args: { botId: string; threadId: string; requestId: string }): UndoThreadModelRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.threadModelRequest);
    const card = message?.card;
    const payload = card?.threadModelRequest;
    if (!message || !card || !payload) return { claimed: false };
    if (card.undone) return { claimed: true, state: "already_undone" };
    const cannot = (error: string, status = 409): UndoThreadModelRequestResult => ({ claimed: true, state: "invalid", error, status });
    if (!card.autoApplied || card.answered !== "allow") return cannot("Only a change that applied on its own can be undone here.");
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return cannot("This model change belongs to another conversation", 403);
    }
    const owner = this.store.bot(payload.targetBotId);
    const task = owner ? this.store.taskByThread(owner.id, payload.targetThreadId) : undefined;
    if (!owner || !task) return cannot(NO_SUCH_THREAD, 404);
    const refusal = this.authorize(payload.botId, owner, task, payload.threadId);
    if (refusal) return cannot(refusal, 403);
    if (!sameSelection(task.modelSelection ?? owner.modelSelection, payload.selection)) {
      return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    }
    const restore = payload.before ?? payload.beforeDefault;
    if (!payload.before && !sameSelection(owner.modelSelection, payload.beforeDefault)) {
      return { claimed: true, state: "invalid", error: UNDO_STALE, status: 409, stale: true };
    }
    const checked = this.checkSwitch({ ...owner, threadId: payload.targetThreadId, modelSelection: task.modelSelection ?? owner.modelSelection }, restore);
    if (!checked.ok) return cannot(checked.error, checked.status);
    const switched = this.store.switchTaskModel(
      owner.id, payload.targetThreadId, checked.selection, false, false,
      this.resetTask ? this.resetTask(payload.selection, checked.selection) : {},
    );
    if (!switched) return cannot(NO_SUCH_THREAD, 404);
    this.store.patchMessage(args.threadId, message.id, { card: { ...card, undone: true } });
    return { claimed: true, state: "undone", targetBotId: owner.id, targetThreadId: payload.targetThreadId };
  }

  resolve(args: {
    botId: string;
    threadId: string;
    requestId: string;
    behavior: string | undefined;
  }): ResolveThreadModelRequestResult {
    const message = this.store
      .messagesFor(args.threadId)
      .find((candidate) => candidate.card?.requestId === args.requestId && candidate.card.threadModelRequest);
    const card = message?.card;
    const payload = card?.threadModelRequest;
    if (!message || !card || !payload) return { claimed: false, state: "not_found" };
    if (args.behavior !== "allow" && args.behavior !== "deny") {
      return { claimed: true, state: "invalid", error: "Model confirmations must be confirmed or cancelled", status: 400 };
    }
    if (payload.botId !== args.botId || payload.threadId !== args.threadId) {
      return { claimed: true, state: "invalid", error: "This model request belongs to another conversation", status: 403 };
    }
    if (card.answered) return { claimed: true, state: "already_settled", behavior: card.answered };

    let attempted = false;
    try {
      const owner = this.store.bot(payload.targetBotId);
      const task = owner ? this.store.taskByThread(owner.id, payload.targetThreadId) : undefined;
      if (!owner || !task) throw new ThreadModelRequestError(NO_SUCH_THREAD, 404);
      if (args.behavior === "deny") {
        this.store.patchMessage(args.threadId, message.id, { card: { ...card, answered: "deny", held: undefined } });
        return { claimed: true, state: "denied" };
      }
      const refusal = this.authorize(payload.botId, owner, task, payload.threadId);
      if (refusal) throw new ThreadModelRequestError(refusal, 403);
      if (sameSelection(payload.selection, task.modelSelection ?? owner.modelSelection)) {
        const settled = this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, answered: "allow", held: undefined, threadModelRequest: { ...payload, appliedAt: payload.appliedAt ?? this.now() } },
        });
        if (!settled) throw new ThreadModelRequestError("This model confirmation card is no longer available", 409);
        return { claimed: true, state: "already_settled", behavior: "allow" };
      }
      const before = payload.before ?? payload.beforeDefault;
      if (!sameSelection(before, task.modelSelection ?? owner.modelSelection)) {
        throw new ThreadModelRequestError("This conversation's model changed after this card was prepared. Ask the bot to review it and propose again.", 409);
      }
      const checked = this.checkSwitch({ ...owner, threadId: payload.targetThreadId, modelSelection: task.modelSelection ?? owner.modelSelection }, payload.selection);
      if (!checked.ok) throw new ThreadModelRequestError(checked.error, checked.status);
      attempted = true;
      this.apply(payload);

      const appliedAt = this.now();
      const settled = this.store.patchMessage(args.threadId, message.id, {
        card: { ...card, answered: "allow", held: undefined, threadModelRequest: { ...payload, appliedAt } },
      });
      if (!settled) throw new ThreadModelRequestError("This model confirmation card is no longer available", 409);
      return { claimed: true, state: "applied", targetBotId: owner.id, targetThreadId: payload.targetThreadId };
    } catch (error) {
      const status = error instanceof ThreadModelRequestError ? error.status : 400;
      const detail = error instanceof Error ? error.message : String(error);
      const task = this.store.taskByThread(payload.targetBotId, payload.targetThreadId);
      const owner = this.store.bot(payload.targetBotId);
      const applied = attempted && task && owner ? sameSelection(payload.selection, task.modelSelection ?? owner.modelSelection) : false;
      const notice = card.dismissed && card.options.length === 0
        ? "Conversation model saved. Recording the operation receipt could not finish; the change will not be applied again."
        : "Conversation model saved. Confirm again to finish recording this decision; the change will not be applied again.";
      try {
        this.store.patchMessage(args.threadId, message.id, {
          card: { ...card, held: applied ? notice : redactSecretsInText(detail).slice(0, 500) },
        });
      } catch {}
      if (applied) return {
        claimed: true, state: "applied", targetBotId: payload.targetBotId, targetThreadId: payload.targetThreadId,
        settlementPending: true, message: notice,
      };
      return { claimed: true, state: "invalid", error: detail, status };
    }
  }
}
