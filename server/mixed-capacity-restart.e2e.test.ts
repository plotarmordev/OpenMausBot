import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const lines = () => existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n").filter(Boolean) : [];
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
    const wrapper = join(dataDir, "main-cli.mjs");
    writeFileSync(wrapper, ["#!/usr/bin/env node", 'import { existsSync, readFileSync } from "node:fs";',
      `const prompts = ${JSON.stringify(prompts)};`,
      'const count = existsSync(prompts) ? readFileSync(prompts, "utf8").split("\\n").filter(Boolean).length : 0;',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(join(dataDir, "main-release-"))} + count;`,
      "// The fake CLI captures environment at module initialization.",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`].join("\n"), { mode: 0o700 });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ language: "en", threads: { maxConcurrentPerBot: 1 }, instances: {
      claude: { driver: "claudeAgent", config: { cli: wrapper }, environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_PROMPTS: prompts, FAKE_CLAUDE_TOOL_CALLS: "[]" } },
      holder: { driver: "claudeAgent", config: { cli }, environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: holderGate, FAKE_CLAUDE_TOOL_CALLS: "[]" } },
    } }));
    await server.start();
    const paired = await api("POST", "/api/auth/pair", { code: (await api("POST", "/api/auth/pairing", {})).code });
    const bot = (await api("POST", "/api/bots", { name: "Mixed durable queue" })).bot!;
    const threadId = bot.threadId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
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
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "holder", model: "claude-sonnet-5" } });
    await server.stop();
    await server.start();
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(2);
    expect(journal()).toEqual([{ status: "dispatching" }, { status: "pending" }, { status: "pending" }]);
    const routine = (await api("POST", "/api/routines", { name: "Restored queue holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true, schedule: { type: "daily", time: "23:00" } })).routine!;
    await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.some(task => task.threadId !== threadId && task.busy), { timeout: 20_000 }).toBe(true);
    writeFileSync(join(dataDir, "main-release-1"), "");
    await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending" }, { status: "pending" }]);
    expect(lines()).toHaveLength(2);
    expect((await state()).botQueuedMessages[threadId].map(item => item.text)).toEqual(["UNMARKED_SECOND", "PERSON_THIRD"]);
    writeFileSync(holderGate, "");
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(3);
    expect(journal()).toEqual([{ status: "dispatching" }, { status: "pending" }]);
    writeFileSync(join(dataDir, "main-release-2"), "");
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(4);
    expect(journal()).toEqual([{ status: "dispatching" }]);
    writeFileSync(join(dataDir, "main-release-3"), "");
    await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
    const users = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages.filter(message => message.role === "user").map(message => message.text);
    expect(users).toEqual(["INITIAL_INTERRUPTED", "PERSON_FIRST", "UNMARKED_SECOND", "PERSON_THIRD"]);
    expect(lines()).toHaveLength(4);
  } finally {
    writeFileSync(holderGate, "");
    for (let index = 0; index < 4; index++) writeFileSync(join(dataDir, `main-release-${index}`), "");
    await server.close();
    console.info(JSON.stringify({ logPath: server.logPath }));
  }
}, 90_000);
