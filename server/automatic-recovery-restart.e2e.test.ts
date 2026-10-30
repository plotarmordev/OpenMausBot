import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { z } from "zod";

const taskSchema = z.object({ threadId: z.string(), busy: z.boolean().optional(), modelSelection: z.object({ instanceId: z.string(), model: z.string() }).optional() });
const botSchema = z.object({ id: z.string(), activeTaskId: z.string().optional(), chiefOfStaff: z.boolean().optional(), tasks: z.array(taskSchema).default([]) });
const responseSchema = z.object({
  bots: z.array(botSchema).default([]), bot: botSchema.optional(), task: taskSchema.optional(),
  routine: z.object({ id: z.string() }).optional(), botQueuedMessages: z.record(z.string(), z.array(z.unknown())).default({}),
  messages: z.array(z.object({ role: z.string(), at: z.number(), text: z.string().optional(), queueId: z.string().optional(),
    requestCancelled: z.boolean().optional(), turnSucceeded: z.boolean().optional(),
    roomRequest: z.object({ id: z.string(), phase: z.string() }).optional(),
    tool: z.object({ name: z.string(), ok: z.boolean().optional() }).optional() })).default([]),
});
const createdBotSchema = z.object({ bot: z.object({ id: z.string(), activeTaskId: z.string() }) });

const primary = { instanceId: "opencodeGo", model: "fixture/recovery" };
const backup = { instanceId: "claude", model: "claude-sonnet-5" };
const lines = (path: string): Array<{ method?: string; cwd?: string; botId?: string; threadId?: string; model?: string; prompt?: unknown }> =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

it.each(["missing-order-restart", "equal-ms-before", "equal-ms-restart", "disabled", "dispatching", "pending", "superseded", "stopped", "stopped-restart",
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
    const cancelled = mode === "missing-order-restart" || equalMs || changedPlan || mode === "disabled" || mode === "superseded" || mode === "stopped" || mode === "stopped-restart";
    const stopped = mode === "stopped" || mode === "stopped-restart";
    const reported = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try {
        return {
          notifications: db.prepare("SELECT kind FROM notification_log WHERE thread_id = ? AND kind = 'turn-failed'").all(threadId).length,
          incidents: db.prepare("SELECT 1 FROM messages WHERE thread_id <> ? AND json_extract(json, '$.threadRef.threadId') = ? AND instr(json_extract(json, '$.tool.name'), 'could not start') > 0").all(threadId, threadId).length,
        };
      } finally { db.close(); }
    };
    // The Chief hears a could-not-start incident; with none, the report has nowhere to land and its absence proves nothing.
    if (stopped || mode === "disabled") await api("PATCH", `/api/bots/${chief!.id}`, { chiefOfStaff: true });
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
    } else if (mode === "missing-order-restart") {
      await server.stop();
      const db = new DatabaseSync(join(dataDir, "messages.db"));
      try {
        db.prepare("UPDATE messages SET input_order = NULL WHERE thread_id = ?").run(threadId);
      } finally { db.close(); }
      await server.start();
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
        writeFileSync(join(dataDir, "clock-release"), "");
      }
      unlinkSync(failure);
      if (mode === "equal-ms-restart") {
        await server.stop();
        await server.start();
      }
      writeFileSync(holderGate, "");
    } else if (stopped) {
      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
      expect((await messages()).find(message => message.text === "RECOVER_ORIGINAL_LINE")?.requestCancelled).toBe(true);
      expect(await queued()).toEqual([]);
      expect(journal()).toEqual([]);
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
    await expect.poll(async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.some(entry => entry.busy), { timeout: 20_000 }).toBe(false);
    await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
    expect(readHandoffs(dataDir).filter(node => node.threadId === threadId && node.status === "source")).toEqual([]);
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
    if (stopped) {
      expect(page.filter(message => message.turnSucceeded === false || message.tool?.name?.includes("Automatic recovery"))).toEqual([]);
      expect(reported()).toEqual({ notifications: 0, incidents: 0 });
    }
    if (mode === "disabled") await expect.poll(reported, { timeout: 20_000 }).toEqual({ notifications: 1, incidents: 1 });
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

it("hands a drained line that failed at start to its queued recovery, which a restart runs once", async () => {
  const server = await launchRestartableServer();
  const { dataDir } = server;
  const failure = join(dataDir, "failure.json");
  const failureGate = join(dataDir, "failure-release");
  const firstHolderGate = join(dataDir, "holder-release");
  const secondHolder = join(dataDir, "second-holder");
  const secondHolderGate = join(dataDir, "second-holder-release");
  const backupGate = join(dataDir, "backup-release");
  const prompts = join(dataDir, "backup.jsonl");
  const rpc = join(dataDir, "primary.jsonl");
  const text = "DRAINED_LINE_NEEDS_RECOVERY";
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
    // A CLI new enough to refresh a resumed session's prompt, so the thread keeps a record of what it handed Claude.
    config.instances.claude.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_VERSION: "2.1.270" };
    config.automaticRecovery = { enabled: true, backup };
    config.threads = { maxConcurrentPerBot: 1 };
    writeFileSync(configPath, JSON.stringify(config));
    await server.start();
    const chief = (await api("GET", "/api/bots")).bots.find(bot => bot.chiefOfStaff);
    if (chief) await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    const bot = (await api("POST", "/api/bots", { name: "Drained recovery" })).bot!;
    const threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Drained line" })).task!.threadId;
    const state = () => api("GET", "/api/bots?messages=0");
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages;
    const succeeded = async () => (await messages()).filter(message => message.turnSucceeded === true).length;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "WARM_BACKUP_SESSION" });
    await expect.poll(succeeded, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.some(entry => entry.busy), { timeout: 20_000 }).toBe(false);
    const warmed = await succeeded();
    const wrapper = join(dataDir, "recovery-claude.mjs");
    writeFileSync(wrapper, ["#!/usr/bin/env node", 'import { existsSync } from "node:fs";', 'import { basename } from "node:path";',
      'process.env.FAKE_CLAUDE_MODE = "slow";', 'process.env.FAKE_CLAUDE_TOOL_CALLS = "[]";',
      `if (basename(process.cwd()) === ${JSON.stringify(threadId)}) {`,
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(backupGate)};`,
      `process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(prompts)};`, "} else {",
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = existsSync(${JSON.stringify(secondHolder)}) ? ${JSON.stringify(secondHolderGate)} : ${JSON.stringify(firstHolderGate)};`,
      "delete process.env.FAKE_CLAUDE_PROMPTS;", "}",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary });
    const holderBusy = async () => (await state()).bots.find(entry => entry.id === bot.id)!.tasks.some(entry => entry.threadId !== threadId && entry.busy);
    const queued = async () => (await state()).botQueuedMessages[threadId] ?? [];
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status, json_extract(payload, '$.recovery') IS NOT NULL AS recovery FROM chat_followups WHERE thread_id = ? ORDER BY rowid").all(threadId); }
      finally { db.close(); }
    };
    const handed = () => {
      const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
      const bots: Array<{ id: string; tasks?: Array<{ threadId: string; handedMessages?: Record<string, unknown> }> }> = Array.isArray(saved) ? saved : saved.bots;
      return bots.find(entry => entry.id === bot.id)?.tasks?.find(task => task.threadId === threadId)?.handedMessages;
    };
    expect(handed()).toMatchObject({ [backup.instanceId]: { session: expect.any(String) } });
    writeFileSync(failure, JSON.stringify({ code: -32603, message: "Internal error", data: { details: "Upstream connection timed out" } }));
    const { routine } = await api("POST", "/api/routines", { name: "Capacity holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true, schedule: { type: "daily", time: "23:00" } });
    await api("POST", `/api/routines/${routine!.id}/run`);
    await expect.poll(holderBusy, { timeout: 20_000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text });
    await expect.poll(async () => (await queued()).length, { timeout: 20_000 }).toBe(1);
    const initializes = () => lines(rpc).filter(call => call.method === "initialize").length;
    const before = initializes();
    writeFileSync(firstHolderGate, "");
    await expect.poll(initializes, { timeout: 20_000 }).toBeGreaterThan(before);
    expect(journal()).toEqual([{ status: "dispatching", recovery: 0 }]);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 2 } });
    writeFileSync(secondHolder, "");
    await api("POST", `/api/routines/${routine!.id}/run`);
    await expect.poll(holderBusy, { timeout: 20_000 }).toBe(true);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    writeFileSync(failureGate, "");
    await expect.poll(() => lines(rpc).some(call => call.method === "initialize.error"), { timeout: 20_000 }).toBe(true);
    await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending", recovery: 1 }]);
    expect(lines(prompts)).toHaveLength(0);
    const handedBefore = handed();
    await server.stop();
    await server.start();
    expect(handed()).toEqual(handedBefore);
    await expect.poll(() => lines(prompts).length, { timeout: 20_000 }).toBe(1);
    writeFileSync(backupGate, "");
    await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
    await expect.poll(succeeded, { timeout: 20_000 }).toBeGreaterThan(warmed);
    const page = await messages();
    writeFileSync(`${server.logPath}.drained-recovery.json`, JSON.stringify({ page, prompts: lines(prompts), handedBefore, handedAfter: handed() }, null, 2));
    expect(page.filter(message => message.tool?.name.includes("may have already run"))).toEqual([]);
    expect(page.filter(message => message.role === "user" && message.text === text)).toHaveLength(1);
    expect(lines(prompts)).toHaveLength(1);
    expect(JSON.stringify(lines(prompts)[0])).toContain(text);
  } finally {
    writeFileSync(failureGate, ""); writeFileSync(firstHolderGate, ""); writeFileSync(secondHolderGate, ""); writeFileSync(backupGate, "");
    await server.close();
    console.info(JSON.stringify({ logPath: server.logPath }));
  }
}, 120_000);

it.each(["continues", "stopped after restart", "ended before restart"] as const)("coordinated recovery pending across a restart: %s", async mode => {
  const continues = mode === "continues";
  const server = await launchRestartableServer({ scripted: true });
  const { dataDir } = server;
  const failure = join(dataDir, "failure.json");
  const failureGate = join(dataDir, "failure-release");
  const holderGate = join(dataDir, "holder-release");
  const holderReady = join(dataDir, "holder-ready");
  const backupGate = join(dataDir, "backup-release");
  const backupReady = join(dataDir, "backup-ready");
  const rpc = join(dataDir, "primary.jsonl");
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(server.url + path, { method, headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return responseSchema.parse(result);
  };
  const control = async (...args: string[]) => createdBotSchema.parse(await runControlOmb([...args, "--url", server.url]));
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
    const starter = (await api("GET", "/api/bots")).bots.find(bot => bot.chiefOfStaff);
    if (starter) await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    const { bot: chief } = await control("new-bot", "--name", "Restart Chief", "--section", "Leadership");
    const { bot: specialist } = await control("new-bot", "--name", "Restart specialist", "--section", "Engineering");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true });
    await api("PATCH", `/api/bots/${specialist.id}/tasks/${specialist.activeTaskId}`, { modelSelection: primary, updateBotDefault: true });
    const holderThread = (await api("POST", `/api/bots/${specialist.id}/tasks`, { title: "Slot holder" })).task!.threadId;
    await api("PATCH", `/api/bots/${specialist.id}/tasks/${holderThread}`, { modelSelection: backup });
    const brief = "RESTARTED_COORDINATED_RECOVERY_4K";
    const specialistReply = "SPECIALIST_RECOVERED_AFTER_RESTART_5L";
    const finalReply = "Chief received the restarted specialist result";
    writeFileSync(server.planPath, JSON.stringify({
      [chief.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [specialist.id], request_key: "restart-recovery", message: brief } }], reply: "Assigned" },
        continues ? { expectContextIncludes: [specialistReply], reply: finalReply } : { reply: "Chief saw the stopped delegation" },
      ] },
      [specialist.id]: { reply: specialistReply,
        byPrompt: [{ promptIncludes: "HOLD_SPECIALIST_SLOT", plan: { gateFile: holderGate, readyFile: holderReady, reply: "Held" } },
          ...(mode === "stopped after restart" ? [{ promptIncludes: brief, plan: { gateFile: backupGate, readyFile: backupReady, reply: specialistReply } }] : [])] },
    }));
    writeFileSync(failure, JSON.stringify({ code: -32603, message: "Internal error", data: { details: "Upstream connection timed out" } }));
    const primaryTurns = () => lines(rpc).filter(call => call.method === "initialize" && !String(call.cwd ?? "").includes("discovery"));
    await api("POST", `/api/bots/${chief.id}/messages`, { threadId: chief.activeTaskId, text: "Ask Engineering to verify this and report back." });
    await expect.poll(() => readHandoffs(dataDir).find(node => node.parentId)?.status, { timeout: 30_000 }).toBe("running");
    const child = readHandoffs(dataDir).find(node => node.parentId)!;
    await expect.poll(() => primaryTurns().length, { timeout: 20_000 }).toBe(1);
    await api("POST", `/api/bots/${specialist.id}/messages`, { threadId: holderThread, text: "HOLD_SPECIALIST_SLOT" });
    await expect.poll(() => existsSync(holderReady), { timeout: 20_000 }).toBe(true);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    writeFileSync(failureGate, "");
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status, json_extract(payload, '$.recovery.coordination.id') AS node FROM chat_followups WHERE thread_id = ?").all(child.threadId); }
      finally { db.close(); }
    };
    await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending", node: child.id }]);
    const failovers = () => existsSync(join(dataDir, "limit-failovers.json")) ? readFileSync(join(dataDir, "limit-failovers.json"), "utf8") : null;
    const beforeFailovers = failovers();
    const childTask = async () => (await api("GET", "/api/bots?messages=0")).bots.find(bot => bot.id === specialist.id)!.tasks.find(task => task.threadId === child.threadId);
    if (mode === "ended before restart") {
      await api("POST", `/api/bots/${specialist.id}/interrupt`, { threadId: child.threadId });
      await expect.poll(() => readHandoffs(dataDir).find(node => node.id === child.id)?.status, { timeout: 20_000 }).toMatch(/^(failed|cancelled)$/);
    }
    await server.stop();
    await server.start();
    if (mode === "stopped after restart") {
      // A restart frees every slot, so the restored recovery starts at once: Stop reaches its running backup turn.
      await expect.poll(() => existsSync(backupReady), { timeout: 30_000 }).toBe(true);
      await api("POST", `/api/bots/${specialist.id}/interrupt`, { threadId: child.threadId });
      await expect.poll(() => readHandoffs(dataDir).find(node => node.id === child.id)?.status, { timeout: 20_000 }).toMatch(/^(failed|cancelled)$/);
      writeFileSync(backupGate, "");
    }
    writeFileSync(holderGate, "");
    const chiefMessages = async () => (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).messages;
    const idle = async () => (await api("GET", "/api/bots?messages=0")).bots.filter(bot => bot.id === chief.id || bot.id === specialist.id)
      .every(bot => bot.tasks.every(task => !task.busy));
    if (continues) {
      await expect.poll(async () => (await chiefMessages()).some(message => message.text === finalReply), { timeout: 40_000 }).toBe(true);
      await expect.poll(() => readHandoffs(dataDir).find(node => node.id === child.id)?.status, { timeout: 20_000 }).toBe("completed");
    }
    await expect.poll(() => readHandoffs(dataDir).filter(node => !["completed", "failed", "cancelled"].includes(node.status)), { timeout: 40_000 }).toEqual([]);
    await expect.poll(idle, { timeout: 40_000 }).toBe(true);
    await expect.poll(() => journal().filter(row => row.status === "pending"), { timeout: 20_000 }).toEqual([]);
    const nodes = readHandoffs(dataDir);
    const turns = lines(`${server.planPath}.evidence.jsonl`);
    const specialistMessages = (await api("GET", `/api/threads/${child.threadId}/messages?limit=100`)).messages;
    const final = await chiefMessages();
    writeFileSync(`${server.logPath}.coordinated-recovery.json`, JSON.stringify({ mode, nodes, turns, final, specialistMessages, journal: journal() }, null, 2));
    const childTurns = turns.filter(turn => turn.botId === specialist.id && turn.threadId === child.threadId);
    expect(nodes.filter(node => node.threadId === child.threadId)).toHaveLength(1);
    expect(primaryTurns()).toHaveLength(1);
    expect(specialistMessages.filter(message => message.roomRequest?.id === child.id && message.roomRequest.phase === "request")).toHaveLength(1);
    expect(specialistMessages.some(message => message.role === "user")).toBe(false);
    expect(final.filter(message => message.roomRequest?.id === child.id && message.roomRequest.phase === "result").length).toBeLessThanOrEqual(1);
    expect((await api("GET", "/api/bots?messages=0")).botQueuedMessages[child.threadId] ?? []).toEqual([]);
    if (continues) {
      expect(nodes.find(node => node.id === child.id)).toMatchObject({ status: "completed", result: specialistReply });
      expect(nodes.find(node => node.id === child.parentId)?.status).toBe("completed");
      expect(childTurns).toMatchObject([{ model: backup.model }]);
      expect(JSON.stringify(childTurns[0]?.prompt)).toContain(brief);
      expect(JSON.stringify(childTurns[0]?.prompt)).not.toContain("OpenMausBot restarted while your previous turn");
      expect(final.filter(message => message.text === finalReply)).toHaveLength(1);
      expect(final.filter(message => message.roomRequest?.id === child.id && message.roomRequest.phase === "result")).toMatchObject([{ tool: { ok: true } }]);
      expect(final.some(message => message.tool?.name.includes("interrupted"))).toBe(false);
      expect(specialistMessages.filter(message => message.text === specialistReply)).toHaveLength(1);
      expect(specialistMessages.filter(message => message.tool?.name.startsWith("recovery:"))).toHaveLength(1);
    } else {
      const stoppedRunning = mode === "stopped after restart";
      expect(nodes.find(node => node.id === child.id)?.status).not.toBe("completed");
      expect(nodes.find(node => node.id === child.parentId)?.status).toBe("completed");
      expect(childTurns.length).toBeLessThanOrEqual(stoppedRunning ? 1 : 0);
      expect(specialistMessages.some(message => message.text === specialistReply)).toBe(false);
      expect(specialistMessages.filter(message => message.tool?.name.startsWith("recovery:"))).toHaveLength(stoppedRunning ? 1 : 0);
      expect((await childTask())?.modelSelection ?? primary).toEqual(stoppedRunning ? backup : primary);
      expect(failovers()).toBe(beforeFailovers);
      expect(final.filter(message => message.roomRequest?.id === child.id && message.roomRequest.phase === "result")).toHaveLength(1);
      expect(final.filter(message => message.text === "Chief saw the stopped delegation")).toHaveLength(1);
    }
  } finally {
    writeFileSync(failureGate, ""); writeFileSync(holderGate, ""); writeFileSync(backupGate, "");
    await server.close();
    console.info(JSON.stringify({ logPath: server.logPath }));
  }
}, 120_000);
