import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const schema = z.object({
  code: z.string().optional(), token: z.string().optional(), outcome: z.string().optional(),
  bot: z.object({ id: z.string(), threadId: z.string() }).optional(),
  routine: z.object({ id: z.string() }).optional(),
  bots: z.array(z.object({ id: z.string(), tasks: z.array(z.object({ threadId: z.string(), busy: z.boolean().optional() })) })).default([]),
  botQueuedMessages: z.record(z.string(), z.array(z.unknown())).default({}),
  messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string().optional(), card: z.object({ requestId: z.string(), quotaSwitch: z.unknown().optional(), answered: z.string().optional() }).optional() })).default([]),
});

it.each([true, false])("resumes quota after restart only with persisted person marker: %s", async person => {
  const server = await launchRestartableServer();
  const { dataDir } = server;
  const gate = join(dataDir, "holder-release");
  const prompts = join(dataDir, "backup.jsonl");
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
    const model = "claude-sonnet-5";
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ language: "en", threads: { maxConcurrentPerBot: 2 }, instances: {
      claude: { driver: "claudeAgent", displayName: "Limited Claude", config: { cli }, environment: { FAKE_CLAUDE_MODE: "usage-limit" } },
      backup: { driver: "claudeAgent", displayName: "Backup Claude", config: { cli }, environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: prompts, FAKE_CLAUDE_TOOL_CALLS: "[]" } },
      holder: { driver: "claudeAgent", displayName: "Holder Claude", config: { cli }, environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate, FAKE_CLAUDE_TOOL_CALLS: "[]" } },
    } }));
    await server.start();
    const pairing = await api("POST", "/api/auth/pairing", {});
    const paired = await api("POST", "/api/auth/pair", { code: pairing.code });
    const bot = (await api("POST", "/api/bots", { name: "Quota restart" })).bot!;
    const threadId = bot.threadId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "claude", model }, updateBotDefault: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "QUOTA_RESTART_REQUEST" }, person ? paired.token : undefined);
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
    await expect.poll(async () => (await messages()).some(message => message.card?.quotaSwitch), { timeout: 25_000 }).toBe(true);
    const offer = (await messages()).find(message => message.card?.quotaSwitch)!;
    const roots = readHandoffs(dataDir).filter(node => node.threadId === threadId && !node.parentId);
    expect(roots).toHaveLength(1);
    expect(roots[0].capacity).toBe(person ? "person" : undefined);
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "holder", model } });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    await server.stop();
    await server.start();
    expect((await messages()).find(message => message.id === offer.id)?.card?.answered).toBeUndefined();
    const routine = (await api("POST", "/api/routines", { name: "Capacity holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true, schedule: { type: "daily", time: "23:00" } })).routine!;
    await api("POST", `/api/routines/${routine.id}/run`);
    const state = () => api("GET", "/api/bots?messages=0");
    await expect.poll(async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.some(task => task.threadId !== threadId && task.busy), { timeout: 25_000 }).toBe(true);
    expect((await api("POST", `/api/threads/${threadId}/respond`, { requestId: offer.card!.requestId, behavior: "answer", message: "Backup Claude" })).outcome).toBe("answered");
    if (person) {
      await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(1);
      expect((await state()).botQueuedMessages[threadId] ?? []).toHaveLength(0);
    } else {
      await expect.poll(async () => ((await state()).botQueuedMessages[threadId] ?? []).length, { timeout: 20_000 }).toBe(1);
      expect(lines()).toHaveLength(0);
    }
    writeFileSync(gate, "");
    await expect.poll(() => lines().length, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.every(task => !task.busy), { timeout: 20_000 }).toBe(true);
    expect(lines()).toHaveLength(1);
  } finally {
    writeFileSync(gate, "");
    await server.close();
    console.info(JSON.stringify({ person, logPath: server.logPath }));
  }
}, 90_000);
