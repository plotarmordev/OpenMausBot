import { describe, expect, it, vi } from "vitest";

import { RETRY_BLOCKED } from "../incidents.ts";
import { createChiefNotices, type ChiefNoticeDeps } from "./chief-notices.ts";

function fixture(over: Partial<ChiefNoticeDeps> = {}) {
  const bots = [
    { id: "chief", name: "Clive", chiefOfStaff: true, section: "Ops", threadId: "chief-main", tasks: [] as Array<{ threadId: string; title: string }> },
    { id: "ada", name: "Ada", section: "Ops", threadId: "ada-main", tasks: [{ threadId: "ada-main", title: "Ada" }, { threadId: "ada-job", title: "Invoices" }] },
  ];
  const lines = new Map<string, Array<Record<string, unknown>>>();
  let made = 0;
  const store = {
    bots, bot: (id: string) => bots.find((one) => one.id === id),
    tasks: (id: string) => bots.find((one) => one.id === id)?.tasks ?? [],
    taskByThread: (id: string, threadId: string) => bots.find((one) => one.id === id)?.tasks.find((task) => task.threadId === threadId),
    groupByThread: () => undefined,
    createTask: (id: string, title: string) => {
      const task = { threadId: `notices-${++made}`, title };
      bots.find((one) => one.id === id)!.tasks.push(task);
      return task;
    },
    appendMessage: (threadId: string, row: Record<string, unknown>) => {
      const line = { ...row, at: Date.now() };
      lines.set(threadId, [...(lines.get(threadId) ?? []), line]);
      return line;
    },
    messagesFor: (threadId: string) => lines.get(threadId) ?? [],
    activePath: (threadId: string) => lines.get(threadId) ?? [],
  };
  const startTurn = vi.fn(async (_botId: string, _text: string, _opts: { threadId: string }) => undefined);
  const notices = createChiefNotices({
    store: store as never, notify: () => {}, threadBusy: () => false, botAtThreadCapacity: () => false,
    groupTurnActive: () => false, startTurn, assignerOf: () => undefined, escalationsEnabled: () => true, ...over,
  });
  return { notices, store, startTurn, ada: bots[1]! };
}

describe("why a Chief's retry of a teammate's thread is refused", () => {
  it("names a thread that still runs, is shutting down, or waits for a slot", () => {
    expect(fixture({ threadBusy: () => true }).notices.retryRefusal("ada", "ada-job")).toBe(RETRY_BLOCKED.running);
    expect(fixture({ threadBusy: () => true, threadSettling: () => true }).notices.retryRefusal("ada", "ada-job")).toBe(RETRY_BLOCKED.settling);
    expect(fixture({ threadQueued: () => true }).notices.retryRefusal("ada", "ada-job")).toBe(RETRY_BLOCKED.queued);
    expect(fixture().notices.retryRefusal("ada", "ada-job")).toBeNull();
  });

  it("refuses a thread that finished a run since its incident was reported", () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const f = fixture();
      f.notices.reportIncident({ kind: "stalled", bot: f.ada as never, threadId: "ada-job", detail: "no activity for 20 minutes" });
      expect(f.notices.retryRefusal("ada", "ada-job")).toBeNull();
      vi.setSystemTime(2_000);
      f.store.appendMessage("ada-job", { role: "bot", kind: "text", text: "Done.", turnSucceeded: true });
      expect(f.notices.retryRefusal("ada", "ada-job")).toMatch(/^that thread has finished a run since it was reported/);
    } finally {
      vi.useRealTimers();
    }
  });
});
