import type { ServerResponse } from "node:http";
import { approvalModeFor, modelSwitchNeedsAsk, type ApprovalMode } from "../shared/approval-mode.ts";
import { isEffortLevel, type WireBot } from "../shared/wire.ts";
import { isModelVariant, type ModelSelection } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { BotRecord, Store } from "./store.ts";
import type { ThreadModelRequestService } from "./thread-model-requests.ts";
import type { appendDecision } from "./decision-log.ts";

interface ModelValidationDeps {
  registry: Pick<ProviderRegistry, "get" | "cliTarget">;
  hostedModels: { allows(selection: ModelSelection): boolean; error(): string } | null;
  providerInstanceChanging(instanceId: string): boolean;
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  heldKeyRefusal(instanceId: string): string | undefined;
  bot(id: string): BotRecord | null;
  threadBusy(botId: string, threadId: string): boolean;
  activeGroupTurnForBot(botId: string): unknown;
}

export function createModelValidation({ registry, hostedModels, providerInstanceChanging, policyModelRefusal,
  heldKeyRefusal, bot, threadBusy, activeGroupTurnForBot }: ModelValidationDeps) {
  function checkedModelSelection(
    raw: unknown,
    current?: { selection: ModelSelection; busy: boolean },
    requireAvailableModel = false,
  ): { ok: true; selection: ModelSelection } | { ok: false; status: number; error: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, status: 400, error: "modelSelection must be an object" };
    }
    const value = raw as { instanceId?: unknown; model?: unknown; effort?: unknown; variant?: unknown };
    if (typeof value.instanceId !== "string" || !value.instanceId.trim()) {
      return { ok: false, status: 400, error: "modelSelection.instanceId is required" };
    }
    if (typeof value.model !== "string" || !value.model.trim()) {
      return { ok: false, status: 400, error: "modelSelection.model is required" };
    }
    const selection: ModelSelection = {
      instanceId: value.instanceId.trim(),
      model: value.model.trim(),
    };
    if (hostedModels && !hostedModels.allows(selection)) return { ok: false, status: 400, error: hostedModels.error() };
    if (value.effort !== undefined) {
      if (!isEffortLevel(value.effort)) {
        return { ok: false, status: 400, error: `effort "${String(value.effort)}" is not recognized` };
      }
      selection.effort = value.effort;
    }
    if (value.variant !== undefined) {
      if (!isModelVariant(value.variant)) {
        return { ok: false, status: 400, error: "variant must be a non-empty model variant ID" };
      }
      if (value.effort !== undefined) {
        return { ok: false, status: 400, error: "choose either a model variant or an effort level" };
      }
      selection.variant = value.variant;
    }
    const changed = current && (
      selection.instanceId !== current.selection.instanceId ||
      selection.model !== current.selection.model ||
      selection.effort !== current.selection.effort ||
      selection.variant !== current.selection.variant
    );
    if (current?.busy && changed) {
      return { ok: false, status: 409, error: "the bot is working — stop it before changing models" };
    }
    const target = registry.get(selection.instanceId);
    if (providerInstanceChanging(selection.instanceId)) {
      return { ok: false, status: 409, error: "this provider account is being updated — try again shortly" };
    }
    // Free-form model ids: custom engines accept ids outside their catalog, and some drivers learn the catalog only at turn start.
    if (requireAvailableModel) {
      if (!target || !target.enabled) {
        return { ok: false, status: 400, error: `model instance "${selection.instanceId}" is unavailable` };
      }
      const refusal = policyModelRefusal(target);
      if (refusal) return { ok: false, status: 403, error: refusal };
      const offered =
        selection.model === target.models.default ||
        target.models.options.some((option) => option.id === selection.model);
      if (!offered) {
        return {
          ok: false,
          status: 400,
          error: `model "${selection.model}" is not offered by instance "${selection.instanceId}"`,
        };
      }
    }
    const allowed: readonly string[] = target?.adapter.capabilities.effortLevels ?? [];
    if (target && selection.effort !== undefined && !allowed.includes(selection.effort)) {
      return { ok: false, status: 400, error: `effort "${selection.effort}" is not offered by this bot's engine` };
    }
    if (target?.driverKind === "customAcp" && selection.effort !== undefined &&
        !target.models.options.find((option) => option.id === selection.model)?.variants?.some((option) => option.id === selection.effort)) {
      return { ok: false, status: 400, error: `effort "${selection.effort}" is not advertised for model "${selection.model}" — refresh the engine catalog first` };
    }
    if (target && selection.variant !== undefined && !target.adapter.capabilities.modelVariants) {
      return { ok: false, status: 400, error: "model variants are not offered by this bot's engine" };
    }
    if (target && selection.variant !== undefined && requireAvailableModel &&
        !target.models.options.find((option) => option.id === selection.model)?.variants?.some((option) => option.id === selection.variant)) {
      return { ok: false, status: 400, error: `variant "${selection.variant}" is not advertised for model "${selection.model}"` };
    }
    return { ok: true, selection };
  }

  function engineSwitchNeedsAsk(mode: ApprovalMode, from: ModelSelection, to: ModelSelection): boolean {
    return modelSwitchNeedsAsk(mode, registry.cliTarget(from.instanceId)?.driverKind, registry.cliTarget(to.instanceId)?.driverKind);
  }

  function checkedTaskModelSwitch(current: BotRecord, raw: unknown, updateBotDefault: boolean,
    resetApprovalToAsk: boolean, requireAvailableModel = false, trusted = false, nextTurnOnly = false) {
    if (current.approvalGrant) return { ok: false as const, status: 409, error: "Wait for the approval change to finish before switching models" };
    const checked = checkedModelSelection(raw, {
      selection: current.modelSelection, busy: !nextTurnOnly && threadBusy(current.id, current.threadId),
    }, requireAvailableModel);
    if (!checked.ok) return checked;
    const profile = bot(current.id)!;
    if (updateBotDefault) {
      const defaults = checkedModelSelection(checked.selection, {
        selection: profile.modelSelection, busy: Boolean(activeGroupTurnForBot(current.id)),
      });
      if (!defaults.ok) return defaults;
    }
    for (const target of updateBotDefault ? [current, profile] : [current]) {
      const mode = approvalModeFor(target);
      if (resetApprovalToAsk && mode === "custom" && !trusted) {
        return { ok: false as const, status: 403, error: "Leaving Custom approval requires confirmation in the packaged desktop app" };
      }
      if (!resetApprovalToAsk && modelSwitchNeedsAsk(mode,
        registry.cliTarget(target.modelSelection.instanceId)?.driverKind,
        registry.cliTarget(checked.selection.instanceId)?.driverKind)) {
        return { ok: false as const, status: 400, error: "Confirm switching this model with Ask permissions first (resetApprovalToAsk)" };
      }
    }
    if (resetApprovalToAsk && (threadBusy(current.id, current.threadId) ||
      (updateBotDefault && activeGroupTurnForBot(current.id)))) {
      return { ok: false as const, status: 409, error: "Stop work in the selected scope before switching its permissions" };
    }
    return checked;
  }

  function checkedNativeModelSelection(raw: unknown) {
    const checked = checkedModelSelection(raw, undefined, true);
    if (!checked.ok) return checked;
    const refusal = heldKeyRefusal(checked.selection.instanceId);
    return refusal ? { ok: false as const, status: 403, error: refusal } : checked;
  }

  function checkedNativeTaskModelSwitch(current: BotRecord, raw: unknown) {
    const checked = checkedTaskModelSwitch(current, raw, false, false, true, false, true);
    if (!checked.ok) return checked;
    const refusal = heldKeyRefusal(checked.selection.instanceId);
    return refusal ? { ok: false as const, status: 403, error: refusal } : checked;
  }

  return { checkedModelSelection, checkedTaskModelSwitch, engineSwitchNeedsAsk, checkedNativeModelSelection, checkedNativeTaskModelSwitch };
}

export interface ThreadModelReceipt {
  botDefault: ModelSelection;
  taskOverride: ModelSelection | null;
  currentExecution: { selection: ModelSelection | null; model: string | null; effort: string | null; scope: "current_turn" } | null;
  nextTurn: { selection: ModelSelection; scope: "next_turn"; resolved: false };
  dispatched: false;
}

interface ThreadModelHostDeps {
  store: Store;
  threadModelRequests: ThreadModelRequestService;
  threadBusy(botId: string, threadId: string): boolean;
  directTurnBots: ReadonlyMap<string, BotRecord>;
  sessionModelByThread: ReadonlyMap<string, string>;
  sessionEffortByThread: ReadonlyMap<string, string>;
  turnSelection(botId: string, threadId: string): ModelSelection | undefined;
  decide(row: Parameters<typeof appendDecision>[1]): void;
  broadcast(frame: { kind: "bot"; bot: WireBot }): void;
  wireBot(bot: BotRecord): WireBot;
  json(res: ServerResponse, status: number, body: unknown): unknown;
}

export function createThreadModelHost({ store, threadModelRequests, threadBusy, directTurnBots, sessionModelByThread,
  sessionEffortByThread, turnSelection, decide, broadcast, wireBot, json }: ThreadModelHostDeps) {
  function threadModelReceipt(botId: string, threadId: string): ThreadModelReceipt {
    const bot = store.bot(botId)!;
    const task = store.taskByThread(botId, threadId);
    const running = threadBusy(botId, threadId);
    return {
      botDefault: bot.modelSelection,
      taskOverride: task?.modelSelection ?? null,
      currentExecution: running ? {
        selection: directTurnBots.get(threadId)?.modelSelection ?? null,
        model: sessionModelByThread.get(threadId) ?? null,
        effort: sessionEffortByThread.get(threadId) ?? null,
        scope: "current_turn",
      } : null,
      nextTurn: { selection: turnSelection(botId, threadId) ?? task?.modelSelection ?? bot.modelSelection, scope: "next_turn", resolved: false },
      dispatched: false,
    };
  }

  function resolveAndSendThreadModel(
    res: ServerResponse,
    args: { botId: string; botName?: string; threadId: string; requestId: string; behavior: string },
  ): boolean {
    const card = store.messagesFor(args.threadId).find(
      (message) => message.card?.requestId === args.requestId && message.card.threadModelRequest,
    )?.card;
    if (!card) return false;
    const result = threadModelRequests.resolve(args);
    if (!result.claimed) return false;
    if (result.state === "applied" || result.state === "denied") {
      decide({
        threadId: args.threadId, requestId: args.requestId, botId: args.botId, botName: args.botName,
        tool: "set_thread_model", summary: card.subtitle,
        decision: result.state === "applied" ? "user-approved" : "user-denied", source: "user",
      });
    }
    if (result.state === "applied") {
      const target = store.bot(result.targetBotId);
      if (target) broadcast({ kind: "bot", bot: wireBot(target) });
      json(res, 200, {
        ok: true, outcome: "allowed-once",
        ...(result.settlementPending ? { settlementPending: true, message: result.message } : {}),
      });
      return true;
    }
    if (result.state === "invalid") { json(res, result.status, { error: result.error }); return true; }
    if (result.state === "already_settled") {
      json(res, 200, { ok: true, outcome: result.behavior === "allow" ? "allowed-once" : "rejected", alreadySettled: true });
      return true;
    }
    json(res, 200, { ok: true, outcome: "rejected" });
    return true;
  }
  return { threadModelReceipt, resolveAndSendThreadModel };
}
