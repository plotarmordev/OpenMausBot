import { failedTurnTool } from "../../shared/failed-turn.ts";
import { recoveryCapabilityError } from "../automatic-recovery.ts";
import { instanceConfigs, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import type { Coordinator, HandoffView, HostTurnResult } from "../coordinator.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import type { hostedModelPolicy } from "../hosted-models.ts";
import { limitBackupAllowed, type LimitFailovers } from "../limit-failover.ts";
import { hasQueuedInputAfter } from "../message-db.ts";
import { cancelSteeredMessage, isSteeredMessageQueued, onSteeredRecoveryCancelled, queueSteeredMessage, type SteerQueueHead } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { QueuedAutomaticRecovery, SerializableTurnOptions, TurnOptions } from "../turn-options.ts";

type RecoveryCallbacks = Pick<TurnOptions, "coordination" | "onSettled" | "onTurnSettled" | "onDispatchError">;

export interface QueuedRecoveryDeps {
  store: Store;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get">;
  hostedModels: ReturnType<typeof hostedModelPolicy>;
  coordinator(): Pick<Coordinator, "node">;
  ended: ReadonlySet<HandoffView["status"]>;
  limitFailovers(): Pick<LimitFailovers, "record">;
  directRequestOwners: { get(threadId: string): { stopped?: boolean } | undefined };
  directCoordinationSettlers: { delete(generation: string): boolean };
  directFollowupSettlers: { delete(generation: string): boolean };
  checkedTaskModelSwitch(current: BotRecord, raw: unknown, updateBotDefault: boolean, resetApprovalToAsk: boolean,
    requireAvailableModel?: boolean): { ok: true; selection: ModelSelection } | { ok: false };
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  settleDirectFollowup(generation: string | undefined, outcome: HostTurnResult): void;
  settleDirectCoordination(generation: string | undefined, outcome: HostTurnResult): void;
  botAtThreadCapacity(botId: string, capacity?: "person"): boolean;
  startTurn(botId: string, text: string, opts?: TurnOptions): Promise<Message>;
  interruptDirectThread(botId: string, threadId: string): Promise<void>;
  drainQueuedSends(): void;
  /** The turn-failed notification and could-not-start incident a person-facing turn gets when it never started. */
  reportCouldNotStart(bot: BotRecord, threadId: string, message: string, options: SerializableTurnOptions): void;
}

export function createQueuedRecovery(deps: QueuedRecoveryDeps) {
  const { store, cfg, registry, hostedModels, ended, directRequestOwners } = deps;
  const callbacksByQueueId = new Map<string, RecoveryCallbacks>();
  const coordinatedAtBoot = new Map<string, string>();
  const pendingRootsAtBoot = new Set<string>();

  function settleUnstarted(botId: string, threadId: string, queueId: string, recovery: QueuedAutomaticRecovery, message: string) {
    const callbacks = callbacksByQueueId.get(queueId);
    callbacksByQueueId.delete(queueId);
    deps.settleDirectFollowup(recovery.generation, { ok: false, text: message });
    store.appendMessage(threadId, { role: "bot", kind: "activity", turnSucceeded: false, tool: failedTurnTool(message) });
    const bot = store.projectBotForTask(botId, threadId);
    if (bot) deps.reportCouldNotStart(bot, threadId, message, recovery.options);
    callbacks?.onDispatchError?.(message);
  }

  onSteeredRecoveryCancelled((botId, id, threadId, recovery) =>
    settleUnstarted(botId, threadId, id, recovery, "Automatic recovery cancelled before the backup started."));

  /** One currency rule for an immediate and a queued recovery: the live request decides; after a restart, only a stopped line that was the request itself. */
  function requestStopped(threadId: string, line: Message | undefined, coordinated: boolean): boolean {
    const owner = directRequestOwners.get(threadId);
    return owner ? Boolean(owner.stopped) : !coordinated && Boolean(line?.requestCancelled);
  }

  function commit(botId: string, threadId: string, recovery: QueuedAutomaticRecovery) {
    store.switchTaskModel(botId, threadId, recovery.selection, false, false, {
      ...hostedModels?.resetTask(recovery.from, recovery.selection), rewound: true,
    });
    if (recovery.limit) deps.limitFailovers().record({ botId, threadId, from: recovery.from, to: recovery.selection, resetsAt: recovery.limit.resetsAt, at: Date.now() });
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: recovery.activity, ok: true } });
  }

  function plan(bot: BotRecord | null): QueuedAutomaticRecovery["plan"] {
    if (!cfg.automaticRecovery?.enabled) return { source: "disabled", steps: [] };
    if (bot?.fallback?.length) return { source: "task", steps: bot.fallback };
    return { source: "global", steps: cfg.automaticRecovery.backup ? [cfg.automaticRecovery.backup] : [] };
  }

  function prepare(opts: TurnOptions | undefined, threadId: string, userMessage: Message, automaticRecoveryIndex: number,
    fields: Omit<QueuedAutomaticRecovery, "options" | "coordination">): QueuedAutomaticRecovery {
    const { coordination, onSettled: _onSettled, onTurnSettled: _onTurnSettled, onDispatchError: _onDispatchError, recovery: _recovery,
      followupIds: _followupIds, ...serializable } = opts ?? {};
    return {
      ...fields,
      options: { ...serializable, threadId, userMessage, editedMessageId: undefined,
        automaticRecoveryAttempted: true, automaticRecoveryIndex },
      ...(coordination ? { coordination: { id: coordination.id, resumed: coordination.resumed } } : {}),
    };
  }

  /** Queues the recovery behind a full bot; false when a slot is free and the caller commits now. */
  function queueIfFull(botId: string, threadId: string, text: string, opts: TurnOptions | undefined, recovery: QueuedAutomaticRecovery): boolean {
    if (!deps.botAtThreadCapacity(botId, opts?.capacity)) return false;
    const queued = queueSteeredMessage(botId, threadId, text, {
      reason: "capacity", recovery, capacity: opts?.capacity, trigger: opts?.trigger,
      origin: opts?.origin, peerAsk: opts?.peerAsk, via: opts?.via, callId: opts?.callId, replaces: opts?.followupIds,
    });
    callbacksByQueueId.set(queued.id, { coordination: opts?.coordination, onSettled: opts?.onSettled, onTurnSettled: opts?.onTurnSettled, onDispatchError: opts?.onDispatchError });
    return true;
  }

  /** Throws `recovery_refused` when the recovery is no longer current; otherwise commits the backup selection. */
  function admit(botId: string, threadId: string, recovery: QueuedAutomaticRecovery, ownsOutcome: boolean) {
    const refused = refusal(botId, threadId, recovery);
    if (refused) throw Object.assign(new Error(refused), { status: 409, code: "recovery_refused" });
    commit(botId, threadId, recovery);
    if (ownsOutcome) deps.directCoordinationSettlers.delete(recovery.generation);
    else deps.settleDirectCoordination(recovery.generation, { ok: false, text: "The failed attempt is being retried on the backup." });
  }

  /** Why a recovery may no longer commit; undefined when it may. */
  function refusal(botId: string, threadId: string, recovery: QueuedAutomaticRecovery): string | undefined {
    const current = store.projectBotForTask(botId, threadId);
    const configured = plan(current);
    const step = configured.steps[(recovery.options.automaticRecoveryIndex ?? 0) - 1];
    const checked = current && step && deps.checkedTaskModelSwitch(current, step, false, false, true);
    const latestInput = store.activePath(threadId).findLast(m => m.role === "user" && m.kind === "text");
    const target = registry.get(recovery.selection.instanceId);
    if (cfg.automaticRecovery?.enabled !== true || !current || !store.taskByThread(botId, threadId)?.cwd ||
        latestInput?.id !== recovery.recoveryUserMessageId || requestStopped(threadId, latestInput, Boolean(recovery.coordination)) ||
        hasQueuedInputAfter("bot", botId, threadId, recovery.recoveryUserMessageId, recovery.coordinatedInputOrder) ||
        JSON.stringify(current.modelSelection) !== JSON.stringify(recovery.from) ||
        JSON.stringify(configured) !== JSON.stringify(recovery.plan) ||
        !checked?.ok || JSON.stringify(checked.selection) !== JSON.stringify(recovery.selection) ||
        !target?.enabled) {
      return "Automatic recovery cancelled: the request or backup selection is no longer current.";
    }
    const source = registry.get(recovery.from.instanceId);
    const why = !source ? "The original AI is no longer configured, so the backup cannot be checked against it."
      : deps.policyModelRefusal(target) ?? recoveryCapabilityError(
        { driverKind: source.driverKind, capabilities: source.adapter.capabilities },
        { driverKind: target.driverKind, capabilities: target.adapter.capabilities })
      ?? (recovery.limit && !limitBackupAllowed(source, target, instanceConfigs(cfg)[target.instanceId])
        ? "The backup now uses the same subscription whose usage limit was reached." : undefined)
      ?? (hostedModels && !hostedModels.allows(recovery.selection) ? hostedModels.error() : undefined);
    return why ? `Automatic recovery unavailable: ${why}` : undefined;
  }

  function coordinationEnded(nodeId: string): boolean {
    const node = deps.coordinator().node(nodeId);
    return !node || ended.has(node.status);
  }

  /** A restored coordinated recovery waits for its node to resume and own it. */
  function waitsForNode(head: SteerQueueHead): boolean {
    return Boolean(head.recovery?.coordination && !callbacksByQueueId.has(head.messageId ?? "") && !coordinationEnded(head.recovery.coordination.id));
  }

  function dispatch(botId: string, threadId: string, prompt: string, queueId: string, recovery: QueuedAutomaticRecovery): Promise<void | "retry"> {
    return new Promise<void | "retry">((resolve) => {
      const callbacks = callbacksByQueueId.get(queueId);
      let refused: string | undefined;
      try {
        refused = recovery.coordination && !callbacks
          ? "Automatic recovery cancelled: the coordinated work it continued has ended."
          : refusal(botId, threadId, recovery);
      } catch (error) {
        refused = `Automatic recovery could not start: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (refused) {
        settleUnstarted(botId, threadId, queueId, recovery, refused);
        resolve();
        deps.drainQueuedSends();
        return;
      }
      void deps.startTurn(botId, prompt, {
        ...recovery.options, ...callbacks, threadId, userMessage: recovery.userMessage, recovery, followupIds: [queueId],
        onTurnSettled: () => { callbacks?.onTurnSettled?.(); resolve(); },
      }).then(() => {
        callbacksByQueueId.delete(queueId);
        deps.directCoordinationSettlers.delete(recovery.generation);
        deps.directFollowupSettlers.delete(recovery.generation);
      }).catch(error => {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "thread_limit") { resolve("retry"); return; }
        const message = error instanceof Error ? error.message : String(error);
        settleUnstarted(botId, threadId, queueId, recovery, code === "recovery_refused" ? message : `Automatic recovery could not start: ${message}`);
        resolve();
      });
    });
  }

  /** A restored coordinated node resumes by owning its queued recovery, never by a rerun; undefined for any other node. */
  function resumeRestored(node: HandoffView, resumed: boolean, signal: AbortSignal): Promise<HostTurnResult> | undefined {
    const queueId = node.groupId ? undefined : coordinatedAtBoot.get(node.id);
    if (queueId === undefined) return undefined;
    coordinatedAtBoot.delete(node.id);
    if (!isSteeredMessageQueued(node.botId, node.threadId, queueId)) {
      return Promise.resolve({ ok: false, text: "Automatic recovery ended before the backup started." });
    }
    return new Promise<HostTurnResult>(resolve => {
      let done = false;
      const finish = (outcome: HostTurnResult) => {
        if (done) return;
        done = true; signal.removeEventListener("abort", abort); resolve(outcome);
      };
      const abort = () => {
        if (!cancelSteeredMessage(node.botId, queueId, node.threadId)) void deps.interruptDirectThread(node.botId, node.threadId).catch(() => {});
        finish({ ok: false, text: "Coordinated work was stopped" });
      };
      callbacksByQueueId.set(queueId, { coordination: { id: node.id, resumed, settle: finish }, onDispatchError: error => finish({ ok: false, text: error }) });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else deps.drainQueuedSends();
    });
  }

  return {
    plan, prepare, queueIfFull, admit, commit, waitsForNode, dispatch, resumeRestored, requestStopped,
    noteBootRow: (queueId: string, recovery: QueuedAutomaticRecovery | undefined) => {
      if (recovery?.coordination) coordinatedAtBoot.set(recovery.coordination.id, queueId);
      else if (recovery) pendingRootsAtBoot.add(recovery.generation);
    },
    restoredAtBoot: (nodeId: string) => coordinatedAtBoot.has(nodeId),
    pendingRootAtBoot: (nodeId: string) => pendingRootsAtBoot.has(nodeId),
  };
}
