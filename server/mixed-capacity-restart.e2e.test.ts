import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { z } from "zod";
import { launchRestartableServer } from "./testing/restartable-server.ts";

const schema = z.object({
  code: z.string().optional(), token: z.string().optional(),
  bot: z.object({ id: z.string(), threadId: z.string() }).optional(), routine: z.object({ id: z.string() }).optional(),
  bots: z.array(z.object({ id: z.string(), tasks: z.array(z.object({ threadId: z.string(), busy: z.boolean().optional() })) })).default([]),
  botQueuedMessages: z.record(z.string(), z.array(z.object({ text: z.string() }))).default({}),
  messages: z.array(z.object({ role: z.string(), text: z.string().optional() })).default([]),
});

it("restores mixed queue order and durable dispatch without coalescing or duplicate prompts", async () => {
  const server = await launchRestartableServer();
  const { dataDir } = server;
  const prompts = join(dataDir, "main.jsonl");
  const holderGate = join(dataDir, "holder-release");
  const mainGate = join(dataDir, "main-release");
  const lines = () => existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n").filter(Boolean)
    .map(line => z.object({ method: z.string() }).parse(JSON.parse(line))).filter(line => line.method === "session/prompt") : [];
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(server.url + path, { method,
      headers: { "content-type": "application/json", origin: server.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return schema.parse(result);
  };
  try {
    await server.stop();
    const cli = fileURLToPath(new URL("./testing/fake-claude-cli.ts", import.meta.url));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ language: "en", threads: { maxConcurrentPerBot: 1 }, instances: {
      opencodeGo: { driver: "opencodeGo", config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
        environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_MODELS: "fixture/queue", FAKE_ACP_RPC_APPEND_FILE: prompts, FAKE_ACP_GATE_FILE: mainGate } },
      holder: { driver: "claudeAgent", config: { cli }, environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: holderGate, FAKE_CLAUDE_TOOL_CALLS: "[]" } },
    } }));
    await server.start();
    const paired = await api("POST", "/api/auth/pair", { code: (await api("POST", "/api/auth/pairing", {})).code });
    const bot = (await api("POST", "/api/bots", { name: "Mixed durable queue" })).bot!;
    const threadId = bot.threadId;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "holder", model: "claude-sonnet-5" } });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/queue" } });
    const state = () => api("GET", "/api/bots?messages=0");
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status FROM chat_followups WHERE thread_id = ? ORDER BY rowid").all(threadId); }
      finally { db.close(); }
    };
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "INITIAL_INTERRUPTED" });
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(1);
    for (const [text, person] of [["PERSON_FIRST", true], ["UNMARKED_SECOND", false], ["PERSON_THIRD", true]] as const) {
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text }, person ? paired.token : undefined);
    }
    expect(journal()).toEqual([{ status: "pending" }, { status: "pending" }, { status: "pending" }]);
    await server.stop();
    await server.start();
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(2);
    expect(journal()).toEqual([{ status: "dispatching" }, { status: "pending" }, { status: "pending" }]);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 2 } });
    const routine = (await api("POST", "/api/routines", { name: "Restored queue holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true, schedule: { type: "daily", time: "23:00" } })).routine!;
    await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.some(task => task.threadId !== threadId && task.busy), { timeout: 20_000 }).toBe(true);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    writeFileSync(mainGate, "");
    await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(lines()).toHaveLength(2);
    expect((await state()).botQueuedMessages[threadId].map(item => item.text)).toEqual(["UNMARKED_SECOND", "PERSON_THIRD"]);
    unlinkSync(mainGate);
    writeFileSync(holderGate, "");
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(3);
    expect(journal()).toEqual([{ status: "dispatching" }, { status: "pending" }]);
    writeFileSync(mainGate, "");
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(4);
    await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
    const users = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages.filter(message => message.role === "user").map(message => message.text);
    expect(users).toEqual(["INITIAL_INTERRUPTED", "PERSON_FIRST", "UNMARKED_SECOND", "PERSON_THIRD"]);
    expect(lines()).toHaveLength(4);
  } finally {
    writeFileSync(holderGate, "");
    writeFileSync(mainGate, "");
    await server.close();
    console.info(JSON.stringify({ logPath: server.logPath }));
  }
}, 90_000);
