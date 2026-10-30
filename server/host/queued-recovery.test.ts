import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { appendMessage } from "../message-db.ts";
import type { BotRecord, Message } from "../store.ts";
import type { QueuedAutomaticRecovery } from "../turn-options.ts";
import { createQueuedRecovery, type QueuedRecoveryDeps } from "./queued-recovery.ts";

const from = { instanceId: "primary", model: "fixture/primary" };
const selection = { instanceId: "backup", model: "fixture/backup" };
const engine = { enabled: true, driverKind: "claudeAgent", adapter: { capabilities: {} } };

function fixture(threadId: string) {
  const owners = new Map<string, { stopped?: boolean }>();
  const line: Message = { id: `${threadId}-line`, role: "user", kind: "text", text: "Reconcile the invoices.", at: Date.now() };
  appendMessage(threadId, line);
  const switched: unknown[] = [];
  const bot = { id: "bot", modelSelection: from } as BotRecord;
  const deps = {
    store: {
      projectBotForTask: () => bot,
      activePath: () => [line],
      taskByThread: () => ({ cwd: "/work" }),
      switchTaskModel: (_botId: string, _threadId: string, next: unknown) => { switched.push(next); },
      appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => ({ ...message, id: "activity", at: Date.now() }),
    },
    cfg: { automaticRecovery: { enabled: true, backup: selection } } as unknown as AppConfig,
    registry: { get: () => engine },
    hostedModels: undefined,
    coordinator: () => ({ node: () => undefined }),
    ended: new Set(),
    limitFailovers: () => ({ record: () => {} }),
    directRequestOwners: owners,
    directCoordinationSettlers: new Map(),
    directFollowupSettlers: new Map(),
    checkedTaskModelSwitch: () => ({ ok: true, selection }),
    policyModelRefusal: () => undefined,
    settleDirectFollowup: () => {},
    settleDirectCoordination: () => {},
    botAtThreadCapacity: () => false,
    startTurn: async (botId: string, _text: string, opts?: { threadId?: string; recovery?: QueuedAutomaticRecovery }) => {
      recovery.admit(botId, opts!.threadId!, opts!.recovery!, false);
      return line;
    },
    interruptDirectThread: async () => {},
    drainQueuedSends: () => {},
    reportCouldNotStart: () => {},
  } as unknown as QueuedRecoveryDeps;
  const recovery = createQueuedRecovery(deps);
  const queued: QueuedAutomaticRecovery = {
    selection, plan: { source: "global", steps: [selection] }, from, userMessage: line, recoveryUserMessageId: line.id,
    activity: "recovery: Trying the backup", generation: `${threadId}-generation`, options: { threadId, automaticRecoveryIndex: 1 },
  };
  return { recovery, owners, line, queued, switched };
}

describe("queued automatic recovery", () => {
  it("applies one currency rule whether or not the request outlived a restart", () => {
    const { recovery, owners, line } = fixture("currency");
    const stoppedLine = { ...line, requestCancelled: true };
    expect(recovery.requestStopped("currency", stoppedLine, false)).toBe(true);
    expect(recovery.requestStopped("currency", stoppedLine, true)).toBe(false);
    owners.set("currency", { stopped: false });
    expect(recovery.requestStopped("currency", stoppedLine, false)).toBe(false);
    expect(recovery.requestStopped("currency", stoppedLine, true)).toBe(false);
    owners.set("currency", { stopped: true });
    expect(recovery.requestStopped("currency", line, true)).toBe(true);
  });

  it("checks and commits a queued recovery in the dispatching tick", () => {
    const { recovery, queued, switched } = fixture("commit");
    void recovery.dispatch("bot", "commit", "Reconcile the invoices.", "commit-queue", queued);
    expect(switched).toEqual([selection]);
  });
});
