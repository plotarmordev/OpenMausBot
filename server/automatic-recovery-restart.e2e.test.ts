import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { z } from "zod";

const taskSchema = z.object({ threadId: z.string(), busy: z.boolean().optional(), modelSelection: z.object({ instanceId: z.string(), model: z.string() }).optional() });
const botSchema = z.object({ id: z.string(), chiefOfStaff: z.boolean().optional(), tasks: z.array(taskSchema).default([]) });
const responseSchema = z.object({
  bots: z.array(botSchema).default([]), bot: botSchema.optional(), task: taskSchema.optional(),
  routine: z.object({ id: z.string() }).optional(), botQueuedMessages: z.record(z.string(), z.array(z.unknown())).default({}),
  messages: z.array(z.object({ role: z.string(), at: z.number(), text: z.string().optional(), queueId: z.string().optional(),
    requestCancelled: z.boolean().optional(), turnSucceeded: z.boolean().optional(), tool: z.object({ name: z.string() }).optional() })).default([]),
});

const primary = { instanceId: "opencodeGo", model: "fixture/recovery" };
const backup = { instanceId: "claude", model: "claude-sonnet-5" };
const lines = (path: string): Array<{ method?: string }> => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

it.each(["equal-ms-before", "equal-ms-restart", "disabled", "dispatching", "pending", "superseded", "stopped", "stopped-restart",
  "global-changed", "global-changed-restart", "fallback-changed", "fallback-changed-restart",
  "fallback-reordered", "fallback-reordered-restart", "fallback-removed", "fallback-removed-restart"] as const)("settles %s recovery without replaying the original line", async mode => {
  const equalMs = mode.startsWith("equal-ms");
  const server = await launchRestartableServer(equalMs ? { frozenNow: Date.now() } : {});
  const { dataDir } = server;
  const failure = join(dataDir, "failure.json");
  const failureGate = join(dataDir, "failure-release");
  const holderGate = join(dataDir, "holder-release");
  const backupGate = join(dataDir, "backup-release");
  const prompts = join(dataDir, "backup.jsonl");
  const rpc = join(dataDir, "primary.jsonl");
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(server.url + path, { method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return responseSchema.parse(result);
  };
  try {
    await server.stop();
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.opencodeGo = { driver: "opencodeGo", displayName: "Primary fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FAKE_ACP_MODELS: primary.model, FAKE_ACP_RPC_APPEND_FILE: rpc,
        FAKE_ACP_RPC_FAILURE_FILE: failure, FAKE_ACP_RPC_FAILURE_METHOD: "initialize", FAKE_ACP_RPC_FAILURE_GATE: failureGate } };
    config.automaticRecovery = { enabled: true, backup };
    config.threads = { maxConcurrentPerBot: 2 };
    writeFileSync(configPath, JSON.stringify(config));
    await server.start();
    const { bots } = await api("GET", "/api/bots");
    const chief = bots.find(bot => bot.chiefOfStaff);
    if (chief) await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    const bot = (await api("POST", "/api/bots", { name: "Recovery restart" })).bot!;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Ordinary recovery" })).task!;
    const threadId = task.threadId;
    const wrapper = join(dataDir, "recovery-claude.mjs");
    writeFileSync(wrapper, ["#!/usr/bin/env node", 'import { basename } from "node:path";',
      'process.env.FAKE_CLAUDE_MODE = "slow";', 'process.env.FAKE_CLAUDE_TOOL_CALLS = "[]";',
      `if (basename(process.cwd()) === ${JSON.stringify(threadId)}) {`,
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(backupGate)};`,
      `process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(prompts)};`, "} else {",
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(holderGate)};`, "delete process.env.FAKE_CLAUDE_PROMPTS;", "}",
      "// The fake CLI captures environment at module initialization.",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary });
    const alternate = { ...backup, model: "claude-opus-5" };
    if (mode.startsWith("fallback-")) await api("PATCH", `/api/bots/${bot.id}`, { fallback: [backup, alternate] });
    writeFileSync(failure, JSON.stringify({ code: -32603, message: "Internal error", data: { details: "Upstream connection timed out" } }));
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "RECOVER_ORIGINAL_LINE" });
    await expect.poll(() => lines(rpc).some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    const { routine } = await api("POST", "/api/routines", { name: "Capacity holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true, schedule: { type: "daily", time: "23:00" } });
    await api("POST", `/api/routines/${routine!.id}/run`);
    const state = () => api("GET", "/api/bots?messages=0");
    const current = async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.find(entry => entry.threadId === threadId)!;
    await expect.poll(async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.some(entry => entry.threadId !== threadId && entry.busy), { timeout: 20_000 }).toBe(true);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    if (mode === "equal-ms-before") {
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "NEWER_USER_INTENT" });
    }
    writeFileSync(failureGate, "");
    await expect.poll(() => lines(rpc).some(call => call.method === "initialize.error"), { timeout: 20_000 }).toBe(true);
    const queued = async () => (await state()).botQueuedMessages[threadId] ?? [];
    await expect.poll(async () => (await queued()).length, { timeout: 20_000 }).toBe(1);
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT id, status FROM chat_followups WHERE thread_id = ?").all(threadId); }
      finally { db.close(); }
    };
    expect(journal()).toMatchObject([{ status: "pending" }]);
    expect(lines(prompts)).toHaveLength(0);
    expect((await current()).modelSelection).toEqual(primary);
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
    expect((await messages()).filter(message => message.tool?.name?.startsWith("recovery:"))).toHaveLength(0);
    const failovers = () => existsSync(join(dataDir, "limit-failovers.json")) ? readFileSync(join(dataDir, "limit-failovers.json"), "utf8") : null;
    const beforeFailovers = failovers();
    const changedPlan = mode.startsWith("global-") || mode.startsWith("fallback-");
    const cancelled = equalMs || changedPlan || mode === "disabled" || mode === "superseded" || mode === "stopped" || mode === "stopped-restart";
    if (changedPlan) {
      if (mode.startsWith("global-")) {
        await api("PATCH", "/api/config", { automaticRecovery: { enabled: true, backup: alternate } });
      } else {
        const fallback = mode.startsWith("fallback-removed") ? [] :
          mode.startsWith("fallback-reordered") ? [alternate, backup] : [alternate];
        await api("PATCH", `/api/bots/${bot.id}`, { fallback });
      }
      if (mode.endsWith("-restart")) {
        await server.stop();
        await server.start();
      }
      writeFileSync(holderGate, "");
    } else if (mode === "disabled") {
      await api("PATCH", "/api/config", { automaticRecovery: { enabled: false, backup } });
      writeFileSync(holderGate, "");
    } else if (mode === "superseded" || equalMs) {
      if (mode !== "equal-ms-before") {
        await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "NEWER_USER_INTENT" });
        expect(await queued()).toHaveLength(2);
        expect(journal()).toMatchObject([{ status: "pending" }, { status: "pending" }]);
      }
      if (equalMs) {
        const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
        try {
          const queuedAt = db.prepare("SELECT json_extract(payload, '$.queuedAt') AS at FROM chat_followups WHERE thread_id = ? AND json_extract(payload, '$.text') = ?").get(threadId, "NEWER_USER_INTENT")!.at;
          expect(queuedAt).toBe((await messages()).find(message => message.text === "RECOVER_ORIGINAL_LINE")!.at);
        } finally { db.close(); }
      }
      unlinkSync(failure);
      if (mode === "equal-ms-restart") {
        await server.stop();
        await server.start();
      }
      writeFileSync(holderGate, "");
    } else if (mode === "stopped" || mode === "stopped-restart") {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
      expect((await messages()).find(message => message.text === "RECOVER_ORIGINAL_LINE")?.requestCancelled).toBe(true);
      expect(journal()).toMatchObject([{ status: "pending" }]);
      if (mode === "stopped-restart") {
        await server.stop();
        await server.start();
        expect((await messages()).find(message => message.text === "RECOVER_ORIGINAL_LINE")?.requestCancelled).toBe(true);
      }
      writeFileSync(holderGate, "");
    } else {
      if (mode === "dispatching") {
        writeFileSync(holderGate, "");
        await expect.poll(() => lines(prompts).length, { timeout: 20_000 }).toBe(1);
        expect(journal()).toMatchObject([{ status: "dispatching" }]);
      }
      await server.stop();
      expect(journal()).toMatchObject([{ status: mode }]);
      await server.start();
      writeFileSync(holderGate, "");
      if (mode === "pending") await expect.poll(() => lines(prompts).length, { timeout: 20_000 }).toBe(1);
      writeFileSync(backupGate, "");
    }
    await expect.poll(async () => (await queued()).length, { timeout: 20_000 }).toBe(0);
    await delay(1_000);
    const page = await messages();
    const users = page.filter(message => message.role === "user" && message.text === "RECOVER_ORIGINAL_LINE");
    expect(users).toHaveLength(1);
    expect(users[0].queueId).toBeUndefined();
    if (mode === "dispatching") expect(readHandoffs(dataDir).filter(node => node.threadId === threadId && node.status === "source")).toHaveLength(0);
    expect(lines(prompts)).toHaveLength(cancelled ? 0 : 1);
    if (cancelled) {
      expect((await current()).modelSelection).toEqual(primary);
      expect(page.filter(message => message.tool?.name?.startsWith("recovery:"))).toHaveLength(0);
      expect(failovers()).toBe(beforeFailovers);
    }
    if (mode === "superseded" || equalMs) {
      await expect.poll(async () => (await messages()).some(message => message.turnSucceeded === true), { timeout: 20_000 }).toBe(true);
      expect((await messages()).filter(message => message.role === "user" && message.text === "NEWER_USER_INTENT")).toHaveLength(1);
      expect(lines(rpc).filter(call => call.method === "session/prompt")).toHaveLength(1);
      expect((await messages()).some(message => message.tool?.name?.includes("interrupted"))).toBe(false);
      expect(readHandoffs(dataDir).filter(node => node.threadId === threadId && node.status === "source")).toHaveLength(0);
    }
    if (mode === "dispatching") expect(page.some(message => message.tool?.name?.includes("interrupted"))).toBe(true);
    if (mode === "pending") await expect.poll(async () => (await messages()).some(message => message.turnSucceeded === true), { timeout: 20_000 }).toBe(true);
    await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
  } finally {
    writeFileSync(failureGate, ""); writeFileSync(holderGate, ""); writeFileSync(backupGate, "");
    await server.close();
    console.info(JSON.stringify({ mode, logPath: server.logPath }));
  }
}, 90_000);
