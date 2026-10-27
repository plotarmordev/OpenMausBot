import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ThreadModelRequestService, type OptionCardLike, type ThreadModelRequestStore } from "./thread-model-requests.ts";
import type { ModelSelection } from "../shared/wire.ts";
import type { BotRecord, TaskRecord } from "./store.ts";
import { type DirectApplyCheck } from "./direct-apply.ts";

interface StoredMessage {
  id: string;
  card?: OptionCardLike;
}

const SONNET: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const HAIKU: ModelSelection = { instanceId: "claude", model: "claude-haiku-5" };
const GPT: ModelSelection = { instanceId: "codex", model: "gpt-fixture" };

class MemoryStore implements ThreadModelRequestStore {
  readonly bots = new Map<string, BotRecord>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly threads = new Map<string, StoredMessage[]>();
  readonly switches: Array<{ botId: string; threadId: string; selection: ModelSelection; taskPatch: Record<string, unknown> }> = [];
  private sequence = 0;

  bot(id: string): BotRecord | undefined {
    return this.bots.get(id);
  }

  botByThread(threadId: string): BotRecord | null {
    return [...this.bots.values()].find((bot) => (bot.tasks ?? []).some((task) => task.threadId === threadId)) ?? null;
  }

  taskByThread(botId: string, threadId: string): TaskRecord | undefined {
    return this.tasks.get(`${botId}:${threadId}`);
  }

  messagesFor(threadId: string): StoredMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  appendMessage(
    threadId: string,
    message: { role: "bot"; kind: "options"; card: OptionCardLike; from?: { botId: string; name: string; color: string } },
  ): StoredMessage {
    const stored: StoredMessage = { id: "message-" + ++this.sequence, card: message.card };
    const messages = this.threads.get(threadId) ?? [];
    messages.push(stored);
    this.threads.set(threadId, messages);
    return stored;
  }

  patchMessage(threadId: string, messageId: string, patch: { card: OptionCardLike }): StoredMessage | null {
    const message = this.messagesFor(threadId).find((candidate) => candidate.id === messageId);
    if (!message) return null;
    message.card = patch.card;
    return message;
  }

  switchTaskModel(
    botId: string, threadId: string, selection: ModelSelection,
    _updateBotDefault: boolean, _resetApprovalToAsk: boolean, taskPatch: Record<string, unknown> = {},
  ): TaskRecord | null {
    const task = this.taskByThread(botId, threadId);
    const bot = this.bots.get(botId);
    if (!task || !bot) return null;
    this.switches.push({ botId, threadId, selection: structuredClone(selection), taskPatch: structuredClone(taskPatch) });
    task.modelSelection = sameSelectionForTest(selection, bot.modelSelection) ? undefined : structuredClone(selection);
    return task;
  }
}

const sameSelectionForTest = (a: ModelSelection, b: ModelSelection) =>
  a.instanceId === b.instanceId && a.model === b.model && a.effort === b.effort && a.variant === b.variant;

function addBot(store: MemoryStore, name: string, selection: ModelSelection = SONNET): BotRecord {
  const record = {
    id: randomUUID(), threadId: randomUUID(), name, title: "", description: "", soul: "",
    notifications: true, color: "blue", unread: false, resumeCursors: {},
    modelSelection: structuredClone(selection),
  } as unknown as BotRecord;
  store.bots.set(record.id, record);
  return record;
}

function addThread(store: MemoryStore, owner: BotRecord, task: Partial<TaskRecord> = {}): TaskRecord {
  const record = {
    threadId: randomUUID(), title: "Fixture check", createdAt: 1,
    resumeCursors: { claude: "cursor-1" },
    ...task,
  } as unknown as TaskRecord;
  store.tasks.set(`${owner.id}:${record.threadId}`, record);
  owner.tasks = [...(owner.tasks ?? []), record] as TaskRecord[];
  return record;
}

function harness(options: {
  autoApply?: DirectApplyCheck;
  refuse?: string;
  refuseSwitch?: string;
} = {}) {
  const store = new MemoryStore();
  const chief = addBot(store, "Clive");
  const mate = addBot(store, "Ada");
  const service = new ThreadModelRequestService({
    store,
    autoApply: options.autoApply ?? (() => "level"),
    authorize: () => options.refuse ?? null,
    checkSwitch: (_current, raw) => {
      if (options.refuseSwitch) return { ok: false, status: 400, error: options.refuseSwitch };
      const value = raw as ModelSelection;
      if (!value || typeof value !== "object" || !value.instanceId || !value.model) {
        return { ok: false, status: 400, error: "modelSelection.instanceId is required" };
      }
      return { ok: true, selection: structuredClone(value) };
    },
    resetTask: (from, to) => ({ lastContextModel: `${from.model}->${to.model}` }),
  });
  return { store, chief, mate, service };
}

describe("ThreadModelRequestService", () => {
  it("applies at once through the picker's own write, pins only the model, and leaves the session cursors alone", () => {
    const { store, chief, mate, service } = harness();
    const thread = addThread(store, mate, { openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 } });
    const proposed = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked" });
    expect(proposed.state).toBe("applied");
    expect(store.switches).toEqual([
      { botId: mate.id, threadId: thread.threadId, selection: GPT, taskPatch: { lastContextModel: "claude-sonnet-5->gpt-fixture" } },
    ]);
    expect(thread.modelSelection).toEqual(GPT);
    expect(mate.modelSelection).toEqual(SONNET);
    expect(thread.resumeCursors).toEqual({ claude: "cursor-1" });
    expect(thread.approvalMode).toBeUndefined();
  });

  it("shows the change as a person-facing applied notice with Undo, in the Chief's own conversation", () => {
    const { store, chief, mate, service } = harness();
    const thread = addThread(store, mate, { openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 } });
    const proposed = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: HAIKU, reason: "asked" });
    const card = store.messagesFor(chief.threadId).find((message) => message.card?.requestId === proposed.requestId)!.card!;
    expect(card).toMatchObject({ autoApplied: true, answered: "allow", options: [], tool: "set_thread_model", dismissed: true });
    expect(card.title).toContain(`#${thread.title}`);
    expect(card.subtitle).toContain("next turn");
    expect(card.threadModelRequest).toMatchObject({ targetThreadId: thread.threadId, targetBotId: mate.id, selection: HAIKU });
  });

  it("undoes back to the thread's own pinned selection, once", () => {
    const { store, chief, mate, service } = harness();
    const thread = addThread(store, mate, {
      modelSelection: HAIKU,
      openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 },
    });
    const proposed = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked" });
    const undone = service.undo({ botId: chief.id, threadId: chief.threadId, requestId: proposed.requestId });
    expect(undone).toEqual({ claimed: true, state: "undone", targetBotId: mate.id, targetThreadId: thread.threadId });
    expect(thread.modelSelection).toEqual(HAIKU);
    expect(service.undo({ botId: chief.id, threadId: chief.threadId, requestId: proposed.requestId }))
      .toEqual({ claimed: true, state: "already_undone" });
  });

  it("undoes back to following the bot's default, and refuses once that default moved", () => {
    const { store, chief, mate, service } = harness();
    const thread = addThread(store, mate, { openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 } });
    const proposed = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked" });
    expect(service.undo({ botId: chief.id, threadId: chief.threadId, requestId: proposed.requestId }))
      .toMatchObject({ claimed: true, state: "undone" });
    expect(thread.modelSelection).toBeUndefined();

    const again = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked again" });
    mate.modelSelection = HAIKU;
    expect(service.undo({ botId: chief.id, threadId: chief.threadId, requestId: again.requestId }))
      .toMatchObject({ claimed: true, state: "invalid", stale: true });
    expect(thread.modelSelection).toEqual(GPT);
  });

  it("refuses an Undo that is not the card's own conversation, or whose thread moved on", () => {
    const { store, chief, mate, service } = harness();
    const thread = addThread(store, mate, { openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 } });
    const proposed = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked" });
    const stranger = addBot(store, "Stranger");
    expect(service.undo({ botId: stranger.id, threadId: chief.threadId, requestId: proposed.requestId }))
      .toMatchObject({ claimed: true, state: "invalid", status: 403 });
    thread.modelSelection = HAIKU;
    expect(service.undo({ botId: chief.id, threadId: chief.threadId, requestId: proposed.requestId }))
      .toMatchObject({ claimed: true, state: "invalid", stale: true });
  });


  it("surfaces the picker's own refusals: authority, catalog, effort, and nothing-to-change", () => {
    const { store, chief, mate, service } = harness({ refuseSwitch: "model \"nope\" is not offered by instance \"claude\"" });
    const thread = addThread(store, mate, { openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 } });
    expect(() => service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: { instanceId: "claude", model: "nope" }, reason: "asked" }))
      .toThrow(/not offered/);
    const refused = harness({ refuse: "conversations the person started are theirs" });
    const personThread = addThread(refused.store, refused.mate);
    expect(() => refused.service.submit({ botId: refused.chief.id, threadId: refused.chief.threadId, targetThreadId: personThread.threadId, selection: GPT, reason: "asked" }))
      .toThrow(/the person started/);
    const quiet = harness();
    const same = addThread(quiet.store, quiet.mate, { modelSelection: GPT, openedBy: { botId: quiet.chief.id, name: quiet.chief.name, threadId: quiet.chief.threadId, at: 1 } });
    expect(() => quiet.service.submit({ botId: quiet.chief.id, threadId: quiet.chief.threadId, targetThreadId: same.threadId, selection: GPT, reason: "asked" }))
      .toThrow(/Nothing would change/);
    expect(() => service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: "missing", selection: GPT, reason: "asked" }))
      .toThrow(/No conversation matches/);
  });

  it("keeps a pending card for an owner to confirm when nothing applies it directly", () => {
    const { store, chief, mate, service } = harness({ autoApply: () => null });
    const thread = addThread(store, mate, { openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 } });
    const proposed = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked" });
    expect(proposed.state).toBe("pending");
    const card = store.messagesFor(chief.threadId).find((message) => message.card?.requestId === proposed.requestId)!.card!;
    expect(card.options).toEqual(["Confirm", "Cancel"]);
    expect(card.autoApplied).toBeUndefined();
    expect(thread.modelSelection).toBeUndefined();

    expect(service.resolve({ botId: chief.id, threadId: chief.threadId, requestId: proposed.requestId, behavior: "deny" }))
      .toMatchObject({ claimed: true, state: "denied" });
    expect(thread.modelSelection).toBeUndefined();

    const second = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked" });
    expect(service.resolve({ botId: chief.id, threadId: chief.threadId, requestId: second.requestId, behavior: "allow" }))
      .toMatchObject({ claimed: true, state: "applied" });
    expect(thread.modelSelection).toEqual(GPT);
    const applied = store.messagesFor(chief.threadId).find((message) => message.card?.requestId === second.requestId)!.card!;
    expect(applied.threadModelRequest?.appliedAt).toEqual(expect.any(Number));
  });

  it("rechecks authority before confirmation and Undo without changing the selected model", () => {
    const options: { autoApply?: DirectApplyCheck; refuse?: string } = { autoApply: () => null };
    const { store, chief, mate, service } = harness(options);
    const thread = addThread(store, mate);
    const pending = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "asked" });
    options.refuse = "team access revoked";
    expect(service.resolve({ botId: chief.id, threadId: chief.threadId, requestId: pending.requestId, behavior: "allow" }))
      .toMatchObject({ state: "invalid", status: 403 });
    expect(thread.modelSelection).toBeUndefined();
    expect(store.switches).toEqual([]);

    const automatic = { refuse: undefined as string | undefined };
    const active = harness(automatic);
    const target = addThread(active.store, active.mate);
    const applied = active.service.submit({ botId: active.chief.id, threadId: active.chief.threadId, targetThreadId: target.threadId, selection: GPT, reason: "asked" });
    automatic.refuse = "team access revoked";
    expect(active.service.undo({ botId: active.chief.id, threadId: active.chief.threadId, requestId: applied.requestId }))
      .toMatchObject({ state: "invalid", status: 403 });
    expect(target.modelSelection).toEqual(GPT);
  });


  it("redacts and bounds the reason like every other person-facing card", () => {
    const { store, chief, mate, service } = harness();
    const thread = addThread(store, mate, { openedBy: { botId: chief.id, name: chief.name, threadId: chief.threadId, at: 1 } });
    expect(() => service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "x".repeat(501) }))
      .toThrow(/500 characters or fewer/);
    const proposed = service.submit({ botId: chief.id, threadId: chief.threadId, targetThreadId: thread.threadId, selection: GPT, reason: "  use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH now " });
    const card = store.messagesFor(chief.threadId).find((message) => message.card?.requestId === proposed.requestId)!.card!;
    expect(card.threadModelRequest!.reason).not.toContain("sk-ant-api03");
  });
});
