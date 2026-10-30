import { afterEach, expect, it, vi } from "vitest";

import * as journal from "../message-db.ts";
import { isSteeredMessageQueued, onSteeredRecoveryCancelled, queueSteeredMessage } from "../steer-queue.ts";
import type { QueuedAutomaticRecovery } from "../turn-options.ts";
import { createPersonStop, type PersonStopDeps } from "./person-stop.ts";

afterEach(() => {
  vi.restoreAllMocks();
  journal.settleChatFollowups(journal.chatFollowups().map((row) => row.id), null);
});

it("a failing journal write still stops the turn, and the stopped recovery can no longer be dispatched", async () => {
  const botId = "bot-stop-journal";
  const threadId = "thread-stop-journal";
  const recovery = { generation: "stop-journal" } as QueuedAutomaticRecovery;
  const queued = queueSteeredMessage(botId, threadId, "line that failed", { reason: "capacity", recovery });
  const cancelled = vi.fn();
  onSteeredRecoveryCancelled(cancelled);
  const interruptDirectThread = vi.fn(async () => {
    expect(isSteeredMessageQueued(botId, threadId, queued.id)).toBe(false);
  });
  const deps = {
    store: {} as PersonStopDeps["store"],
    routines: () => null,
    handoffs: () => ({ stoppedByPerson: vi.fn() }),
    interruptDirectThread,
    clearUnattended: vi.fn(),
    markStopped: vi.fn(),
    stopGoal: vi.fn(),
  } satisfies PersonStopDeps;
  vi.spyOn(journal, "settleChatFollowups").mockImplementation(() => { throw new Error("disk full"); });

  await expect(createPersonStop(deps).stopThreadForPerson(botId, threadId)).rejects.toThrow("disk full");

  expect(interruptDirectThread).toHaveBeenCalledWith(botId, threadId);
  expect(deps.markStopped).toHaveBeenCalledWith(threadId);
  expect(deps.stopGoal).toHaveBeenCalledWith(threadId);
  expect(isSteeredMessageQueued(botId, threadId, queued.id)).toBe(false);
  expect(cancelled).toHaveBeenCalledWith(botId, queued.id, threadId, recovery);
});
