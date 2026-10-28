import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import type { WireBot, WireTask, WireMessage } from "../shared/wire.ts";

const primary = { instanceId: "opencodeGo", model: "fixture/recovery" };
const backup = { instanceId: "claude", model: "claude-sonnet-5" };
const limitBackup = { instanceId: "claudeWork", model: "claude-sonnet-5" };
const holder = { instanceId: "holder", model: "fixture/holder" };
const transient = { code: -32603, message: "Internal error", data: { details: "Upstream connection timed out" } };
const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
// At boot OpenCode lists its models by opening one ACP session in this
// folder. Those calls are catalog discovery, not the turns under test.
const CATALOG_PROBE_FOLDER = ["", "providers", "opencode", "discovery"].join(sep);
const turnCalls = (path: string) => jsonLines(path).filter((call) => !String(call.cwd ?? "").endsWith(CATALOG_PROBE_FOLDER));

async function withRecoveryFixture(
  options: { enabled?: boolean; method?: string; error?: unknown; afterOutput?: boolean; backupFails?: boolean; gated?: boolean; scripted?: boolean; codexBackup?: boolean; parentPort?: boolean; frozenNow?: number; limitBackup?: boolean },
  check: (fixture: {
    api: (method: string, path: string, body?: unknown, expectedStatus?: number, token?: string) => Promise<any>;
    applyPolicy: (allowedEngines?: string[]) => Promise<void>;
    control: (...args: string[]) => Promise<any>;
    calls: () => Array<{ pid: number; method: string }>;
    backupPrompts: () => any[];
    backupReceipt: () => { argv: string[]; prompt: unknown; systemPrompt: string };
    dataDir: string; failureFile: string; gateFile: string; evidence: unknown[];
  }) => Promise<void>,
) {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined,
    options.scripted ? { scripted: true } : undefined);
  const { dataDir, url, logPath } = fixture.info;
  const failureFile = join(dataDir, "startup-failure.json");
  const gateFile = join(dataDir, "startup-release");
  const rpcFile = join(dataDir, "primary-rpc.jsonl");
  const backupFile = join(dataDir, "backup-prompts.jsonl");
  const evidence: unknown[] = [{ url, options }];
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expectedStatus?: number, token?: string) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    const context = `${method} ${path}: ${JSON.stringify(result)}`;
    if (expectedStatus === undefined) expect(response.ok, context).toBe(true);
    else expect(response.status, context).toBe(expectedStatus);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const cli = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
    config.instances.history = {
      driver: "opencodeGo", displayName: "History fixture", config: { cli },
      environment: { FAKE_ACP_MODELS: primary.model },
    };
    config.instances.opencodeGo = {
      driver: "opencodeGo", displayName: "Primary fixture", config: { cli },
      environment: {
        FAKE_ACP_MODELS: primary.model, FAKE_ACP_RPC_APPEND_FILE: rpcFile,
        FAKE_ACP_RPC_FAILURE_FILE: failureFile, FAKE_ACP_RPC_FAILURE_METHOD: options.method ?? "initialize",
        ...(options.afterOutput ? { FAKE_ACP_RPC_FAILURE_AFTER_OUTPUT: "1" } : {}),
        ...(options.gated ? { FAKE_ACP_RPC_FAILURE_GATE: gateFile } : {}),
      },
    };
    config.instances.secondary = { ...config.instances.opencodeGo, displayName: "Second startup fixture" };
    if (options.codexBackup) config.instances.codex = {
      driver: "codex", config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) },
    };
    config.instances.claude.environment = {
      ...config.instances.claude.environment,
      FAKE_CLAUDE_PROMPTS: backupFile, FAKE_CLAUDE_TOOL_CALLS: "[]",
      FAKE_CLAUDE_MODE: options.backupFails ? "not-logged-in" : "happy",
    };
    config.automaticRecovery = { enabled: options.enabled !== false, backup: options.limitBackup ? limitBackup : backup };
    if (options.limitBackup) {
      config.instances.claudeWork = { ...config.instances.claude, displayName: "Second Claude sign-in",
        environment: { ...config.instances.claude.environment, OMB_FIXTURE_ROLE: "backup" } };
      config.instances.holder = { driver: "opencodeGo", displayName: "Holder fixture", config: { cli },
        environment: { FAKE_ACP_MODELS: holder.model, FAKE_ACP_MODE: "echo-gated",
          FAKE_ACP_GATE_FILE: join(dataDir, "holder-release"), FAKE_ACP_STARTED_FILE: join(dataDir, "holder-started") } };
      config.anthropic = { key: "sk-ant-fixture-pay-per-use", everyClaudeBot: true };
    }
    writeFileSync(configPath, JSON.stringify(config));
    const clockPath = join(dataDir, "frozen-clock.cjs");
    if (options.frozenNow !== undefined) writeFileSync(clockPath, `Date.now = () => ${JSON.stringify(options.frozenNow)};`);
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types",
      ...(options.frozenNow === undefined ? [] : ["--require", clockPath]),
      ...(options.parentPort ? ["--require", fileURLToPath(new URL("./testing/parent-port-adapter.cjs", import.meta.url))] : []),
      fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: options.parentPort ? ["ignore", log, log, "ipc"] : ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    // A later start listens before Codex lists its models (startup-model-catalog.ts), and a recovery backup must be
    // a model the engine offers.
    if (options.codexBackup) await expect.poll(async () => {
      const { instances } = await api("GET", "/api/instances") as { instances: any[] };
      return instances.find((instance) => instance.instanceId === "codex")?.models.options.some((option: any) => option.id === "gpt-fake-default");
    }, { timeout: 20_000 }).toBe(true);
    // Chief first makes the starter its team's Chief, which answers a teammate's failed run with a Team incidents turn
    // of its own on Claude: the backup engine, whose prompts these tests count. Stepped down, only the runs under test run.
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    const starter = bots.find((bot) => bot.chiefOfStaff)!;
    await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    // Armed once the server is up: the failure is the turns' to meet, not the
    // model discovery the server runs while it starts.
    writeFileSync(failureFile, JSON.stringify(options.error ?? transient));
    await check({
      api, control, calls: () => turnCalls(rpcFile), backupPrompts: () => jsonLines(backupFile),
      applyPolicy: async (allowedEngines = ["opencodeGo"]) => {
        const acknowledgement = once(server!, "message", { signal: AbortSignal.timeout(10_000) });
        server!.send({ type: "openmausbot:managed-desktop-policy", requestId: "recovery-policy", policy: {
          organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Fixture Policy",
          expiresAt: Date.now() + 60_000, version: 3, companyModelsOnly: false, allowedEngines,
          mcp: { allowCustom: true, allowlist: [] },
          computers: { thisComputer: true, localVm: true, box: true, vps: true }, remoteAccess: true,
        } });
        const [message] = await acknowledgement;
        expect(message).toMatchObject({ type: "openmausbot:managed-desktop-result", requestId: "recovery-policy", ok: true });
      },
      backupReceipt: () => {
        const { argv, prompt, systemPrompt } = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
        return { argv, prompt, systemPrompt };
      },
      dataDir, failureFile, gateFile, evidence,
    });
  } finally {
    evidence.push({ calls: jsonLines(rpcFile), backupPrompts: jsonLines(backupFile) });
    const evidencePath = `${logPath}.automatic-recovery.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}

it("supersedes equal-ms recovery before committing the backup", async () => {
  await withRecoveryFixture({ gated: true, frozenNow: Date.now() }, async ({ api, control, calls, backupPrompts, dataDir, failureFile, gateFile }) => {
    const { bot } = await control("new-bot", "--name", "Equal millisecond");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary });
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as WireMessage[];
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status, json_extract(payload, '$.queuedAt') AS at FROM chat_followups WHERE thread_id = ?").all(threadId); }
      finally { db.close(); }
    };
    const failovers = () => existsSync(join(dataDir, "limit-failovers.json")) ? readFileSync(join(dataDir, "limit-failovers.json"), "utf8") : null;
    const beforeFailovers = failovers();
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "EQUAL_MS_ORIGINAL" }, 202);
    await expect.poll(() => calls().some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "EQUAL_MS_NEWER" }, 202);
    expect(journal()).toEqual([{ status: "pending", at: (await messages()).find(message => message.text === "EQUAL_MS_ORIGINAL")!.at }]);
    writeFileSync(gateFile, "");
    await expect.poll(() => calls().some(call => call.method === "initialize.error"), { timeout: 20_000 }).toBe(true);
    rmSync(failureFile);
    await expect.poll(async () => (await messages()).some(message => message.turnSucceeded), { timeout: 20_000 }).toBe(true);
    expect(backupPrompts()).toHaveLength(0);
    expect((await messages()).filter(message => message.tool?.name.startsWith("recovery:"))).toHaveLength(0);
    expect(failovers()).toBe(beforeFailovers);
    const current = (await api("GET", "/api/bots?messages=0")).bots.find((entry: WireBot) => entry.id === bot.id);
    expect(current.tasks.find((task: WireTask) => task.threadId === threadId).modelSelection).toEqual(primary);
    expect((await messages()).filter(message => message.role === "user").map(message => message.text)).toEqual(["EQUAL_MS_ORIGINAL", "EQUAL_MS_NEWER"]);
    expect(calls().filter(call => call.method === "session/prompt")).toHaveLength(1);
    expect((await messages()).some(message => message.tool?.name.includes("interrupted"))).toBe(false);
    expect(readHandoffs(dataDir).filter(node => node.threadId === threadId && node.status === "source")).toHaveLength(0);
    expect(journal()).toEqual([]);
  });
}, 90_000);

it.each(["older ordinary head", "pending policy refusal", "pending cancellation", "pending stop", "pending journal fault"] as const)("admits recovery safely with %s", async (scenario) => {
  await withRecoveryFixture({ gated: true, parentPort: scenario === "pending policy refusal", ...(scenario === "older ordinary head" ? { frozenNow: Date.now() } : {}) }, async ({ api, control, calls, backupPrompts, applyPolicy, dataDir, gateFile, evidence }) => {
    const marked = scenario === "older ordinary head";
    const byPerson = scenario === "pending cancellation" || scenario === "pending stop";
    const { bot } = await control("new-bot", "--name", "Recovery admission");
    const threadId = bot.activeTaskId;
    const text = marked ? "PERSON_MAIN_NEEDS_RECOVERY" : "ORDINARY_NEEDS_RECOVERY";
    const older = "OLDER_ORDINARY_QUEUE_HEAD";
    const holderGate = join(dataDir, "admission-holder-release");
    const wrapper = join(dataDir, "admission-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { basename } from "node:path";',
      `if (basename(process.cwd()) !== ${JSON.stringify(threadId)}) {`,
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(holderGate)};`,
      'delete process.env.FAKE_CLAUDE_PROMPTS;',
      "}",
      "// The fake CLI reads its environment at module initialization.",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: marked ? 1 : 2 } });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary });
    const state = () => api("GET", "/api/bots?messages=0");
    const tasks = async () => (await state()).bots.find((entry: WireBot) => entry.id === bot.id).tasks as WireTask[];
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as WireMessage[];
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status FROM chat_followups WHERE thread_id = ? AND id <> 'journal-fault' ORDER BY rowid").all(threadId); }
      finally { db.close(); }
    };
    const notifications = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT kind FROM notification_log WHERE thread_id = ? AND kind = 'turn-failed'").all(threadId); }
      finally { db.close(); }
    };
    const starter = (await api("GET", "/api/bots")).bots.find((entry: WireBot) => entry.id !== bot.id) as WireBot;
    const incidents = async () => {
      const notices = (await state()).bots.find((entry: WireBot) => entry.id === starter.id).tasks.find((task: WireTask & { title?: string }) => task.title === "Team incidents");
      if (!notices) return [];
      const lines = (await api("GET", `/api/threads/${notices.threadId}/messages?limit=100`)).messages as Array<WireMessage & { threadRef?: { threadId: string } }>;
      return lines.filter(line => line.threadRef?.threadId === threadId).map(line => line.tool?.name);
    };
    const failovers = () => existsSync(join(dataDir, "limit-failovers.json")) ? readFileSync(join(dataDir, "limit-failovers.json"), "utf8") : null;
    const beforeFailovers = failovers();
    if (!marked) {
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text }, 202);
      await expect.poll(() => calls().some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    }
    const { routine } = await api("POST", "/api/routines", {
      name: "Admission holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    try {
      await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => (await tasks()).some(task => task.threadId !== threadId && task.busy), { timeout: 20_000 }).toBe(true);
      await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
      if (marked) {
        await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: older }, 202);
        expect((await state()).botQueuedMessages[threadId].map((item: { text: string }) => item.text)).toEqual([older]);
        const paired = await api("POST", "/api/auth/pair", { code: (await api("POST", "/api/auth/pairing", {})).code });
        await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text }, 202, paired.token);
      }
      await expect.poll(() => calls().some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
      if (marked) {
        const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
        try {
          const queuedAt = db.prepare("SELECT json_extract(payload, '$.queuedAt') AS at FROM chat_followups WHERE thread_id = ?").get(threadId)!.at;
          expect(queuedAt).toBe((await messages()).find(message => message.text === text)!.at);
        } finally { db.close(); }
      }
      writeFileSync(gateFile, "");
      await expect.poll(() => calls().some(call => call.method === "initialize.error"), { timeout: 20_000 }).toBe(true);
      if (marked) {
        await expect.poll(() => backupPrompts().length, { timeout: 20_000 }).toBe(1);
        await expect.poll(async () => (await tasks()).find(task => task.threadId === threadId)?.busy, { timeout: 20_000 }).toBe(false);
        expect((await tasks()).some(task => task.threadId !== threadId && task.busy)).toBe(true);
        expect((await state()).botQueuedMessages[threadId].map((item: { text: string }) => item.text)).toEqual([older]);
        expect(journal()).toEqual([{ status: "pending" }]);
        expect((await messages()).filter(message => message.role === "user" && message.text === older)).toHaveLength(0);
      } else {
        await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending" }]);
        expect((await tasks()).find(task => task.threadId === threadId)?.modelSelection).toEqual(primary);
        await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: true });
        if (scenario === "pending policy refusal") await applyPolicy();
        else if (scenario === "pending cancellation") await api("DELETE", `/api/bots/${bot.id}/queue/${(await state()).botQueuedMessages[threadId][0].queueId}`, { threadId });
        else if (scenario === "pending stop") {
          await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId });
          expect((await state()).botQueuedMessages[threadId] ?? []).toEqual([]);
          expect(journal()).toEqual([]);
        }
        else {
          // A row the recovery's newer-input check cannot read makes that check throw.
          const db = new DatabaseSync(join(dataDir, "messages.db"));
          try {
            db.prepare("INSERT INTO chat_followups(id, kind, owner_id, thread_id, status, payload, input_order) VALUES ('journal-fault', 'bot', ?, ?, 'pending', 'not json', 1000000000)").run(bot.id, threadId);
          } finally { db.close(); }
        }
      }
      expect((await messages()).filter(message => message.role === "user" && message.text === text)).toHaveLength(1);
      writeFileSync(holderGate, "");
      await expect.poll(async () => ({
        journal: journal(),
        ...(!marked ? {
          selectedModel: (await tasks()).find(task => task.threadId === threadId)?.modelSelection,
          recoveryActivities: (await messages()).filter(message => message.tool?.name.startsWith("recovery:")).map(message => message.tool!.name),
        } : {}),
      }), { timeout: 20_000 }).toEqual({
        journal: scenario === "pending cancellation" ? [{ status: "cancelled" }] : [], ...(!marked ? { selectedModel: primary, recoveryActivities: [] } : {}),
      });
      await expect.poll(async () => (await tasks()).some(task => task.busy), { timeout: 20_000 }).toBe(false);
      const finalMessages = await messages();
      expect(finalMessages.filter(message => message.role === "user" && message.text === text)).toHaveLength(1);
      if (marked) {
        expect(backupPrompts()).toHaveLength(2);
        expect(finalMessages.filter(message => message.role === "user" && message.text === older)).toHaveLength(1);
      } else {
        expect(backupPrompts()).toHaveLength(0);
        expect(failovers()).toBe(beforeFailovers);
        expect((await tasks()).find(task => task.threadId === threadId)?.modelSelection).toEqual(primary);
        expect(finalMessages.filter(message => message.tool?.name.startsWith("recovery:"))).toHaveLength(0);
        if (byPerson) {
          expect(finalMessages.filter(message => message.turnSucceeded === false || message.tool?.name.includes("Automatic recovery"))).toEqual([]);
          expect(notifications()).toEqual([]);
          expect(await incidents()).toEqual([]);
        } else {
          const settledBy = scenario === "pending journal fault" ? "Automatic recovery could not start:" : "Automatic recovery unavailable:";
          expect(finalMessages.filter(message => message.tool?.name.includes(settledBy))).toMatchObject([{ turnSucceeded: false }]);
          expect(notifications()).toEqual([{ kind: "turn-failed" }]);
          await expect.poll(incidents, { timeout: 20_000 }).toEqual([expect.stringContaining("could not start")]);
        }
      }
      evidence.push({ scenario, tasks: await tasks(), messages: finalMessages, journal: journal(), backupPrompts: backupPrompts() });
    } finally {
      writeFileSync(holderGate, "");
      await api("DELETE", `/api/routines/${routine.id}`);
    }
  });
}, 90_000);

it("keeps a queued recovery out of a person's running turn when someone steers it or an ordinary item behind it", async () => {
  await withRecoveryFixture({ gated: true }, async ({ api, control, calls, backupPrompts, dataDir, gateFile, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Recovery steer");
    const threadId = bot.activeTaskId;
    const text = "ORDINARY_LINE_NEEDS_RECOVERY";
    const holderGate = join(dataDir, "steer-holder-release");
    const personGate = join(dataDir, "steer-person-release");
    const steerReceived = join(dataDir, "steer-received");
    const wrapper = join(dataDir, "steer-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { basename } from "node:path";',
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `if (basename(process.cwd()) === ${JSON.stringify(threadId)}) {`,
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(personGate)};`,
      `process.env.FAKE_CLAUDE_STEER_RECEIVED = ${JSON.stringify(steerReceived)};`,
      "} else {",
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(holderGate)};`,
      'delete process.env.FAKE_CLAUDE_PROMPTS;',
      "}",
      "// The fake CLI reads its environment at module initialization.",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 2 } });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary });
    const state = () => api("GET", "/api/bots?messages=0");
    const tasks = async () => (await state()).bots.find((entry: WireBot) => entry.id === bot.id).tasks as WireTask[];
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as WireMessage[];
    const originals = async () => (await messages()).filter(message => message.role === "user" && message.text === text);
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status FROM chat_followups WHERE thread_id = ? ORDER BY rowid").all(threadId); }
      finally { db.close(); }
    };
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text }, 202);
    await expect.poll(() => calls().some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    const { routine } = await api("POST", "/api/routines", {
      name: "Steer holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    try {
      await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => (await tasks()).some(task => task.threadId !== threadId && task.busy), { timeout: 20_000 }).toBe(true);
      await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
      writeFileSync(gateFile, "");
      await expect.poll(() => calls().some(call => call.method === "initialize.error"), { timeout: 20_000 }).toBe(true);
      await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending" }]);
      const [queued] = (await state()).botQueuedMessages[threadId] as Array<{ queueId: string; text: string }>;
      expect(queued.text).toBe(text);
      // The person's own main-chat line runs beside the full bot, on an engine that takes steering mid-turn.
      await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: backup });
      const paired = await api("POST", "/api/auth/pair", { code: (await api("POST", "/api/auth/pairing", {})).code });
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "PERSON_KEEPS_THE_THREAD_BUSY" }, 202, paired.token);
      await expect.poll(backupPrompts, { timeout: 20_000 }).toHaveLength(1);
      expect((await tasks()).find(task => task.threadId === threadId)?.busy).toBe(true);

      const refused = await api("POST", `/api/bots/${bot.id}/queue/${queued.queueId}/steer`, { threadId }, 409);
      expect(refused.code).toBe("recovery_not_steerable");
      expect(existsSync(steerReceived)).toBe(false);
      expect(await originals()).toHaveLength(1);
      expect((await state()).botQueuedMessages[threadId].map((item: { queueId: string }) => item.queueId)).toEqual([queued.queueId]);
      expect(journal()).toEqual([{ status: "pending" }]);

      const ordinary = "ORDINARY_ITEM_STEERED_PAST_THE_RECOVERY";
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: ordinary }, 202);
      const queuedIds = async () => ((await state()).botQueuedMessages[threadId] ?? []).map((item: { queueId: string }) => item.queueId);
      const [, behind] = await queuedIds();
      expect(behind).toBeDefined();
      expect(await queuedIds()).toEqual([queued.queueId, behind]);
      const steer = await api("POST", `/api/bots/${bot.id}/queue/${behind}/steer`, { threadId });
      expect(steer).toMatchObject({ steered: true, queueIds: [behind] });
      await expect.poll(() => existsSync(steerReceived), { timeout: 20_000 }).toBe(true);
      expect(await queuedIds()).toEqual([queued.queueId]);
      expect(journal()).toEqual([{ status: "pending" }]);
      expect(await originals()).toHaveLength(1);
      expect((await messages()).filter(message => message.role === "user" && message.text === ordinary)).toHaveLength(1);

      writeFileSync(personGate, "");
      writeFileSync(holderGate, "");
      await expect.poll(async () => (await tasks()).some(task => task.busy), { timeout: 20_000 }).toBe(false);
      await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
      expect(await originals()).toHaveLength(1);
      expect(backupPrompts()).toHaveLength(1);
      const reply = (await messages()).find(message => message.role === "bot" && message.text?.includes("PERSON_KEEPS_THE_THREAD_BUSY"))?.text;
      expect(reply?.split(" + steered: ")[1]).toBe(ordinary);
      evidence.push({ messages: await messages(), journal: journal(), backupPrompts: backupPrompts() });
    } finally {
      writeFileSync(personGate, "");
      writeFileSync(holderGate, "");
      await api("DELETE", `/api/routines/${routine.id}`);
    }
  });
}, 90_000);

it.each(["ordinary", "person-main"] as const)("recovers at full capacity for %s without a phantom backup", async (kind) => {
  await withRecoveryFixture({ gated: true }, async ({ api, control, calls, backupPrompts, dataDir, gateFile, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Recovery capacity");
    const threadId = kind === "person-main" ? bot.activeTaskId :
      (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Ordinary recovery" })).task.threadId;
    const holderGate = join(dataDir, "holder-release");
    const wrapper = join(dataDir, "capacity-recovery-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { basename } from "node:path";',
      `if (basename(process.cwd()) !== ${JSON.stringify(threadId)}) {`,
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(holderGate)};`,
      'delete process.env.FAKE_CLAUDE_PROMPTS;',
      "}",
      "// The fake CLI reads its environment at module initialization.",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: kind === "ordinary" ? 2 : 1 } });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, approvalMode: "ask" });
    const state = async () => (await api("GET", "/api/bots?messages=0")).bots.find((entry: WireBot) => entry.id === bot.id);
    const task = async () => (await state()).tasks.find((entry: WireTask) => entry.threadId === threadId);
    const send = async () => {
      if (kind === "ordinary") return api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "RECOVER_AT_CAPACITY" }, 202);
      const snapshot = await api("GET", `/api/threads/${threadId}/messages`);
      return api("POST", `/api/bots/${bot.id}/messages/guarded`, {
        threadId, text: "RECOVER_AT_CAPACITY", sendId: "person-recovery-capacity",
        expectedActiveLeafId: snapshot.activeLeafId, expectedApprovalMode: "ask",
        onBehalfOf: { name: "Capacity person", email: "capacity@example.test" },
      }, 202);
    };
    if (kind === "ordinary") {
      await send();
      await expect.poll(() => calls().some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    }
    const { routine } = await api("POST", "/api/routines", {
      name: "Recovery capacity holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    try {
      await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => (await state()).tasks.some((entry: WireTask) => entry.threadId !== threadId && entry.busy), { timeout: 20_000 }).toBe(true);
      await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
      if (kind === "person-main") await send();
      await expect.poll(() => calls().some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
      writeFileSync(gateFile, "");
      await expect.poll(() => calls().some(call => call.method === "initialize.error"), { timeout: 20_000 }).toBe(true);
      if (kind === "ordinary") {
        await expect.poll(async () => {
          const snapshot = await api("GET", "/api/bots?messages=0");
          const current = snapshot.bots.find((entry: WireBot) => entry.id === bot.id).tasks.find((entry: WireTask) => entry.threadId === threadId);
          const { messages } = await api("GET", `/api/threads/${threadId}/messages?limit=100`);
          return { model: current.modelSelection, prompts: backupPrompts().length,
            queued: snapshot.botQueuedMessages[threadId]?.length ?? 0,
            failed: messages.some((message: WireMessage) => message.turnSucceeded === false) };
        }, { timeout: 10_000 }).toEqual({ model: primary, prompts: 0, queued: 1, failed: false });
        writeFileSync(holderGate, "");
      }
      await expect.poll(backupPrompts, { timeout: 20_000 }).toHaveLength(1);
      await expect.poll(async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages
        .some((message: WireMessage) => message.text === "hello from fake claude" && message.turnSucceeded === true),
      { timeout: 20_000 }).toBe(true);
      expect(await task()).toMatchObject({ modelSelection: backup, busy: false });
      const holderBusy = (await state()).tasks.some((entry: WireTask) => entry.threadId !== threadId && entry.busy);
      if (kind === "person-main") {
        expect(holderBusy).toBe(true);
        expect(existsSync(holderGate)).toBe(false);
        writeFileSync(holderGate, "");
      }
      await expect.poll(async () => (await state()).tasks.some((entry: WireTask) => entry.busy), { timeout: 20_000 }).toBe(false);
      await expect.poll(() => {
        const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
        try { return db.prepare("SELECT id FROM chat_followups WHERE thread_id = ?").all(threadId); }
        finally { db.close(); }
      }, { timeout: 20_000 }).toEqual([]);
      expect((await api("GET", "/api/bots?messages=0")).botQueuedMessages[threadId] ?? []).toEqual([]);
      expect(readHandoffs(dataDir).filter(node => node.threadId === threadId && node.status === "source")).toEqual([]);
      const { messages } = await api("GET", `/api/threads/${threadId}/messages?limit=100`);
      expect(messages.filter((message: WireMessage) => message.role === "user" && message.text === "RECOVER_AT_CAPACITY")).toHaveLength(1);
      expect(backupPrompts()).toHaveLength(1);
      evidence.push({ kind, task: await task(), backupPrompts: backupPrompts() });
    } finally {
      writeFileSync(holderGate, "");
      await api("DELETE", `/api/routines/${routine.id}`);
    }
  });
}, 90_000);

it("recovers once on the same thread with its history and permissions, leaving the bot default and sibling unchanged", async () => {
  await withRecoveryFixture({}, async ({ api, control, calls, backupPrompts, backupReceipt, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Recover in place");
    const threadId = bot.activeTaskId;
    const route = `/api/bots/${bot.id}/tasks/${threadId}`;
    const send = (text: string) => control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const wait = () => control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
    await api("PATCH", route, { modelSelection: { ...primary, instanceId: "history" }, approvalMode: "ask" });
    await send("REMEMBER_AUTOMATIC_RECOVERY_7Q");
    expect((await wait()).status).toBe("settled");
    await api("PATCH", route, { modelSelection: primary, updateBotDefault: true });
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling keeps primary" });
    const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    const before = await state();
    const beforeTask = before.tasks.find((task: any) => task.threadId === threadId);
    const text = "RECOVER_THIS_WORK_ONCE_8R";
    await send(text);
    expect((await wait()).status).toBe("settled");
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(1);
    expect(calls().filter((call) => call.method === "session/prompt")).toHaveLength(0);
    expect(backupPrompts()).toHaveLength(1);
    const receipt = backupReceipt();
    const prompt = JSON.stringify(receipt.prompt);
    expect(prompt).toContain("REMEMBER_AUTOMATIC_RECOVERY_7Q");
    expect(prompt).toContain("hello from fake acp");
    expect(prompt.split(text)).toHaveLength(2);
    expect(receipt.argv[receipt.argv.indexOf("--permission-mode") + 1]).toBe("default");
    const messages = (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    expect(messages.filter((message) => message.role === "user" && message.text === text)).toHaveLength(1);
    expect(messages.find((message) => message.role === "user" && message.text === text).requestPending).toBe(false);
    expect(messages.filter((message) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(1);
    expect(messages.findLast((message) => message.role === "bot" && message.kind === "text")).toMatchObject({
      text: "hello from fake claude", turnSucceeded: true,
    });
    const after = await state();
    const task = after.tasks.find((entry: any) => entry.threadId === threadId);
    expect(task).toMatchObject({ modelSelection: backup, busy: false });
    expect(task.approvalMode).toBe(beforeTask.approvalMode);
    expect(task.alwaysAllow).toEqual(beforeTask.alwaysAllow);
    expect(after.modelSelection).toEqual(primary);
    expect(after.approvalMode).toBe(before.approvalMode);
    expect(after.tasks.find((entry: any) => entry.threadId === sibling.threadId).modelSelection).toEqual(primary);
    await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    evidence.push({ beforeTask, task, messages, receipt });
  });
}, 90_000);

it("keeps a Set me up request a setup turn on the backup, and an edit of it too", async () => {
  await withRecoveryFixture({}, async ({ api, control, calls, backupPrompts, backupReceipt, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Recover setup");
    const threadId = bot.activeTaskId;
    const route = `/api/bots/${bot.id}/tasks/${threadId}`;
    const wait = () => control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
    const userText = (prompt: unknown) => JSON.stringify(prompt);
    await api("PATCH", route, { modelSelection: primary, updateBotDefault: true });
    await api("POST", `/api/bots/${bot.id}/setup-request`, { threadId });
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "sort my inbox every morning");
    expect((await wait()).status).toBe("settled");
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(1);
    expect(backupPrompts()).toHaveLength(1);
    const pressed = backupReceipt();
    expect(pressed.systemPrompt).toContain("The user explicitly asked you to set yourself up");
    expect(userText(pressed.prompt)).toContain("Set yourself up for this job: sort my inbox every morning");
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const line = (await messages()).find((message) => message.role === "user");
    expect(line).toMatchObject({ text: "sort my inbox every morning", setupRequest: true });

    // The edit runs on the primary again, which fails again: the backup must still read it as setup.
    await api("PATCH", route, { modelSelection: primary });
    await api("POST", `/api/bots/${bot.id}/messages/${line.id}/edit`, { text: "sort my inbox and my calendar", threadId }, 202);
    expect((await wait()).status).toBe("settled");
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(2);
    expect(backupPrompts()).toHaveLength(2);
    const edited = backupReceipt();
    expect(edited.systemPrompt).toContain("The user explicitly asked you to set yourself up");
    expect(userText(edited.prompt)).toContain("Set yourself up for this job: sort my inbox and my calendar");
    evidence.push({ pressed, edited, messages: await messages() });
  });
}, 120_000);

it("recovers a coordinated specialist and returns its result to the Chief exactly once", async () => {
  await withRecoveryFixture({ scripted: true }, async ({ api, control, calls, dataDir, evidence }) => {
    const { bot: chief } = await control("new-bot", "--name", "Recovery Chief", "--section", "Leadership");
    const { bot: specialist } = await control("new-bot", "--name", "Recovery specialist", "--section", "Engineering");
    await api("PATCH", `/api/bots/${chief.id}`, {
      chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true,
    });
    await api("PATCH", `/api/bots/${specialist.id}/tasks/${specialist.activeTaskId}`, {
      modelSelection: primary, updateBotDefault: true, approvalMode: "ask",
    });
    const brief = "VERIFY_RECOVERED_SPECIALIST_2W";
    const specialistReply = "SPECIALIST_BACKUP_VERIFIED_3X";
    const finalReply = "Chief received the recovered specialist result";
    const planPath = join(dataDir, "room-plan.json");
    writeFileSync(planPath, JSON.stringify({
      [chief.id]: { turns: [
        { steps: [{ arguments: { bot_ids: [specialist.id], request_key: "recovery-check", message: brief } }], reply: "Assigned the recovery check" },
        { expectContextIncludes: [specialistReply], reply: finalReply },
      ] },
      [specialist.id]: { turns: [{ expectContextIncludes: [brief], reply: specialistReply }] },
    }));
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Ask Engineering to verify this task and report the result.");
    expect((await control("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const nodes = readHandoffs(dataDir);
    evidence.push({ nodes });
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => !node.groupId && node.status === "completed" && node.reported)).toBe(true);
    const child = nodes.find((node) => node.botId === specialist.id)!;
    expect(child.result).toBe(specialistReply);
    expect(nodes.find((node) => node.botId === chief.id)!.executions).toBe(2);
    const turns = jsonLines(`${planPath}.evidence.jsonl`);
    expect(turns.filter((turn) => turn.botId === chief.id)).toHaveLength(2);
    expect(turns.filter((turn) => turn.botId === specialist.id)).toHaveLength(1);
    expect(turns.find((turn) => turn.botId === specialist.id)).toMatchObject({
      threadId: child.threadId, model: backup.model, permissionMode: "bypassPermissions",
    });
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(1);
    expect(calls().some((call) => call.method === "session/prompt")).toBe(false);
    const chiefMessages = (await api("GET", `/api/threads/${chief.activeTaskId}/messages?limit=100`)).messages as any[];
    expect(chiefMessages.filter((message) => message.text === finalReply)).toHaveLength(1);
    expect(chiefMessages.filter((message) => message.roomRequest?.id === child.id && message.roomRequest.phase === "result")).toHaveLength(1);
    const specialistMessages = (await api("GET", `/api/threads/${child.threadId}/messages?limit=100`)).messages as any[];
    evidence.push({ chiefMessages, specialistMessages, turns });
    expect(specialistMessages.filter((message) => message.text === specialistReply)).toHaveLength(1);
    expect(specialistMessages.filter((message) => message.roomRequest?.id === child.id && message.roomRequest.phase === "request" && message.text?.includes(brief))).toHaveLength(1);
    expect(specialistMessages.some((message) => message.role === "user")).toBe(false);
    expect(specialistMessages.filter((message) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(1);
    const fleet = await api("GET", "/api/bots");
    expect(fleet.groups).toEqual([]);
    const after = fleet.bots.find((bot: any) => bot.id === specialist.id);
    expect(after.modelSelection).toEqual(primary);
    expect(after.tasks.find((task: any) => task.threadId === child.threadId)).toMatchObject({ modelSelection: backup, approvalMode: "full", busy: false });
    expect(after.tasks.find((task: any) => task.threadId === specialist.activeTaskId).modelSelection).toEqual(primary);
    expect(fleet.bots.find((bot: any) => bot.id === chief.id)).toMatchObject({ busy: false, waitingForTeammates: false });
    await control("messages", "--bot", chief.id, "--task", chief.activeTaskId, "--limit", "20");
    await control("messages", "--bot", specialist.id, "--task", child.threadId, "--limit", "20");
  });
}, 90_000);

it("uses the ordered bot list only for proven pre-prompt failures and leaves defaults and siblings unchanged", async () => {
  await withRecoveryFixture({}, async ({ api, control, calls, backupPrompts, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Ordered startup fallback");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Unchanged sibling" });
    await api("PATCH", `/api/bots/${bot.id}`, { fallback: [{ instanceId: "secondary", model: primary.model }, backup] });
    const text = "ORDERED_STARTUP_ONLY_3F";
    await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(calls().filter(call => call.method === "initialize.error")).toHaveLength(2);
    expect(calls().filter(call => call.method === "session/prompt")).toHaveLength(0);
    expect(backupPrompts()).toHaveLength(1);
    const after = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    expect(after.modelSelection).toEqual(primary);
    expect(after.tasks.find((task: any) => task.threadId === sibling.threadId).modelSelection).toEqual(primary);
    expect(after.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: backup, busy: false });
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "30");
    expect(messages.filter((message: any) => message.role === "user" && message.text === text)).toHaveLength(1);
    expect(messages.filter((message: any) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(2);
    evidence.push({ after, messages });
  });
}, 90_000);

it.each([
  { name: "disabled", enabled: false },
  { name: "prompt already accepted", method: "session/prompt" },
  { name: "partial output", method: "session/prompt", afterOutput: true },
  { name: "authentication failure", error: { code: -32603, message: "Authentication required: invalid API key" } },
])("does not automatically replay when $name", async ({ name: _name, ...options }) => {
  await withRecoveryFixture(options, async ({ api, control, calls, backupPrompts }) => {
    const { bot } = await control("new-bot", "--name", "No replay");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    await api("PATCH", `/api/bots/${bot.id}`, { fallback: [{ instanceId: "secondary", model: primary.model }, backup] });
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "DO_NOT_REPLAY_THIS_9S");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status)
      .toBe(options.afterOutput ? "settled" : "failed");
    expect(backupPrompts()).toHaveLength(0);
    expect(calls().filter((call) => call.method.endsWith(".error"))).toHaveLength(1);
    const state = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    expect(state.tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: primary, busy: false });
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    expect(messages.filter((message: any) => message.role === "user" && message.text === "DO_NOT_REPLAY_THIS_9S")).toHaveLength(1);
    expect(messages.some((message: any) => message.tool?.ok === false)).toBe(true);
    expect(messages.some((message: any) => message.tool?.name?.startsWith("recovery:"))).toBe(false);
  });
}, 90_000);

it("rejects missing or unavailable backup settings through the API without changing the saved recovery choice", async () => {
  await withRecoveryFixture({ enabled: false }, async ({ api, evidence }) => {
    const before = (await api("GET", "/api/config")).automaticRecovery;
    const missing = await api("PUT", "/api/config", { automaticRecovery: { enabled: true } }, 400);
    expect(missing.error).toMatch(/backup|automaticRecovery/i);
    const unavailable = await api("PUT", "/api/config", {
      automaticRecovery: { enabled: true, backup: { instanceId: "missing-fixture-engine", model: "missing-model" } },
    }, 400);
    expect(unavailable.error).toMatch(/unavailable/i);
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual(before);
    const allowed = { enabled: true, backup };
    await api("PUT", "/api/config", { automaticRecovery: allowed });
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual(allowed);
    await api("PUT", "/api/config", { automaticRecovery: { enabled: false } });
    expect((await api("GET", "/api/config")).automaticRecovery).toEqual({ enabled: false });
    evidence.push({ rejectedSettings: [missing, unavailable], acceptedSettings: allowed });
  });
}, 90_000);

it("stops after one failed backup instead of looping between engines", async () => {
  await withRecoveryFixture({ backupFails: true }, async ({ api, control, calls, backupPrompts }) => {
    const { bot } = await control("new-bot", "--name", "One backup attempt");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "ONLY_ONE_BACKUP_4T");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("failed");
    expect(backupPrompts()).toHaveLength(1);
    expect(calls().filter((call) => call.method === "initialize.error")).toHaveLength(1);
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    expect(messages.filter((message: any) => message.role === "user" && message.text === "ONLY_ONE_BACKUP_4T")).toHaveLength(1);
    expect(messages.map((message: any) => message.tool).filter((tool: any) => tool?.ok === false))
      .toEqual([{ name: "error: Not logged in · Please run /login", ok: false, setup: true }]);
  });
}, 90_000);

it.each(["workspace", "bot"])("uses the configured %s backup when Claude refuses a turn because it is signed out", async scope => {
  await withRecoveryFixture({ backupFails: true, codexBackup: true }, async ({ api, control, backupPrompts, evidence }) => {
    const healthy = { instanceId: "codex", model: "gpt-fake-default" };
    await api("PUT", "/api/config", { automaticRecovery: { enabled: true, backup: healthy } });
    const { bot } = await control("new-bot", "--name", "Signed out primary");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, {
      modelSelection: backup, updateBotDefault: true, approvalMode: "ask",
    });
    if (scope === "bot") await api("PATCH", `/api/bots/${bot.id}`, {
      fallback: [{ ...backup, model: "claude-opus-5" }, healthy],
    });
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling keeps Claude" });
    const text = "RECOVER_SIGNED_OUT_CLAUDE_7A";
    await control("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const wait = await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30");
    await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "30");
    const { messages } = await api("GET", `/api/threads/${threadId}/messages?limit=100`);
    const after = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    evidence.push({ wait, messages, after });
    expect(wait.status).toBe("settled");
    expect(backupPrompts()).toHaveLength(1);
    expect(messages.filter((message: any) => message.role === "user" && message.text === text)).toHaveLength(1);
    expect(messages.filter((message: any) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(1);
    expect(messages.find((message: any) => message.tool?.name?.startsWith("recovery:"))?.tool.name).toContain("is signed out");
    expect(messages.some((message: any) => message.tool?.ok === false)).toBe(false);
    expect(messages.find((message: any) => message.role === "user" && message.text === text)?.requestPending).toBe(false);
    expect(messages.findLast((message: any) => message.role === "bot" && message.kind === "text"))
      .toMatchObject({ text: "done from fake codex", turnSucceeded: true });
    expect(after.modelSelection).toEqual(backup);
    expect(after.tasks.find((task: any) => task.threadId === sibling.threadId).modelSelection).toEqual(backup);
    expect(after.tasks.find((task: any) => task.threadId === threadId))
      .toMatchObject({ modelSelection: healthy, approvalMode: "ask", busy: false });
  });
}, 90_000);

it("preserves the sign-in error when automatic recovery is disabled", async () => {
  await withRecoveryFixture({ backupFails: true, codexBackup: true }, async ({ api, control }) => {
    await api("PUT", "/api/config", { automaticRecovery: { enabled: false, backup: { instanceId: "codex", model: "gpt-fake-default" } } });
    const { bot } = await control("new-bot", "--name", "Sign in manually");
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { modelSelection: backup, approvalMode: "ask" });
    await control("send", "--bot", bot.id, "--text", "NO_SIGN_OUT_RECOVERY_4B");
    expect((await control("wait", "--bot", bot.id, "--timeout", "30")).status).toBe("failed");
    const { messages } = await control("messages", "--bot", bot.id, "--limit", "30");
    expect(messages.filter((message: any) => message.tool?.name?.startsWith("recovery:"))).toHaveLength(0);
    expect(messages.map((message: any) => message.tool).filter((tool: any) => tool?.ok === false))
      .toEqual([{ name: "error: Not logged in · Please run /login", ok: false, setup: true }]);
  });
}, 90_000);

it.each(["Stop", "new message"])("does not recover a superseded turn after %s", async (action) => {
  await withRecoveryFixture({ gated: true }, async ({ api, control, calls, backupPrompts, failureFile, gateFile }) => {
    const { bot } = await control("new-bot", "--name", "Respect changed intent");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary, updateBotDefault: true });
    const pendingSend = control("send", "--bot", bot.id, "--task", threadId, "--text", "SUPERSEDED_WORK_5U");
    await expect.poll(() => calls().some((call) => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    if (action === "Stop") await control("interrupt", "--bot", bot.id, "--task", threadId);
    else await control("send", "--bot", bot.id, "--task", threadId, "--text", "NEW_INTENT_6V");
    // The process already holds the first failure. A new process will work;
    // this distinguishes draining the new message from replaying the old one.
    rmSync(failureFile);
    writeFileSync(gateFile, "release");
    await pendingSend;
    if (action === "Stop") await control("send", "--bot", bot.id, "--task", threadId, "--text", "NEW_INTENT_6V");
    const state = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    await expect.poll(() => calls().filter((call) => call.method === "session/prompt.result").length, { timeout: 20_000 }).toBe(1);
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect(backupPrompts()).toHaveLength(0);
    expect((await state()).tasks.find((task: any) => task.threadId === threadId)).toMatchObject({ modelSelection: primary, busy: false });
    const { messages } = await control("messages", "--bot", bot.id, "--task", threadId, "--limit", "20");
    for (const text of ["SUPERSEDED_WORK_5U", "NEW_INTENT_6V"]) {
      expect(messages.filter((message: any) => message.role === "user" && message.text === text)).toHaveLength(1);
    }
  });
}, 90_000);

it("refuses a queued usage-limit recovery whose backup became the same subscription before it could start", async () => {
  await withRecoveryFixture({ limitBackup: true }, async ({ api, backupPrompts, dataDir, evidence }) => {
    const limitGate = join(dataDir, "limit-release");
    const primaryPrompts = join(dataDir, "primary-claude-prompts.jsonl");
    const wrapper = join(dataDir, "limit-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'if (process.env.OMB_FIXTURE_ROLE !== "backup") {',
      'process.env.FAKE_CLAUDE_MODE = "usage-limit";',
      `process.env.FAKE_CLAUDE_LIMITED_GATE = ${JSON.stringify(limitGate)};`,
      `process.env.FAKE_CLAUDE_PROMPTS = ${JSON.stringify(primaryPrompts)};`,
      "}",
      "// The fake CLI reads its environment at module initialization.",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/instances/claudeWork", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 2 } });
    const { bot } = await api("POST", "/api/bots", { name: "Quota revalidation", modelSelection: backup }, 201);
    const threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Limited work" }, 201)).task.threadId;
    const holderThread = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Slot holder" }, 201)).task.threadId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${holderThread}`, { modelSelection: holder });
    const tasks = async () => (await api("GET", "/api/bots?messages=0")).bots.find((entry: WireBot) => entry.id === bot.id).tasks as WireTask[];
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as WireMessage[];
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status, json_extract(payload, '$.recovery.limit') IS NOT NULL AS limited FROM chat_followups WHERE thread_id = ?").all(threadId); }
      finally { db.close(); }
    };
    const failovers = () => existsSync(join(dataDir, "limit-failovers.json")) ? readFileSync(join(dataDir, "limit-failovers.json"), "utf8") : null;
    const beforeFailovers = failovers();
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "LIMITED_WORK_WAITS" }, 202);
    await expect.poll(() => jsonLines(primaryPrompts).length, { timeout: 20_000 }).toBe(1);
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: holderThread, text: "HOLD_THE_SLOT" }, 202);
    await expect.poll(() => existsSync(join(dataDir, "holder-started")), { timeout: 20_000 }).toBe(true);
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    writeFileSync(limitGate, "");
    await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending", limited: 1 }]);
    expect((await tasks()).find(task => task.threadId === threadId)?.modelSelection).toEqual(backup);
    await api("PATCH", "/api/config", { anthropic: { key: "sk-ant-fixture-pay-per-use", everyClaudeBot: false } });
    writeFileSync(join(dataDir, "holder-release"), "");
    await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
    await expect.poll(async () => (await tasks()).some(task => task.busy), { timeout: 20_000 }).toBe(false);
    const final = await messages();
    evidence.push({ final, journal: journal(), backupPrompts: backupPrompts() });
    expect(backupPrompts()).toHaveLength(0);
    expect(jsonLines(primaryPrompts)).toHaveLength(1);
    expect((await tasks()).find(task => task.threadId === threadId)?.modelSelection).toEqual(backup);
    expect(failovers()).toBe(beforeFailovers);
    expect(final.filter(message => message.tool?.name.startsWith("recovery:"))).toHaveLength(0);
    expect(final.filter(message => message.role === "user" && message.text === "LIMITED_WORK_WAITS")).toHaveLength(1);
    expect(final.some(message => message.tool?.name.includes("Automatic recovery unavailable:"))).toBe(true);
  });
}, 90_000);

it("commits a queued recovery without first healing a source the policy now refuses", async () => {
  await withRecoveryFixture({ gated: true, parentPort: true }, async ({ api, control, calls, backupPrompts, applyPolicy, dataDir, gateFile, evidence }) => {
    const { bot } = await control("new-bot", "--name", "Source revalidation");
    const threadId = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Ordinary recovery" })).task.threadId;
    const holderGate = join(dataDir, "source-holder-release");
    const wrapper = join(dataDir, "source-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { basename } from "node:path";',
      `if (basename(process.cwd()) !== ${JSON.stringify(threadId)}) {`,
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = ${JSON.stringify(holderGate)};`,
      'delete process.env.FAKE_CLAUDE_PROMPTS;',
      "}",
      "// The fake CLI reads its environment at module initialization.",
      `await import(${JSON.stringify(new URL("./testing/fake-claude-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 2 } });
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: primary });
    const tasks = async () => (await api("GET", "/api/bots?messages=0")).bots.find((entry: WireBot) => entry.id === bot.id).tasks as WireTask[];
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as WireMessage[];
    const journal = () => {
      const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return db.prepare("SELECT status FROM chat_followups WHERE thread_id = ?").all(threadId); }
      finally { db.close(); }
    };
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "RECOVER_FROM_REFUSED_SOURCE" }, 202);
    await expect.poll(() => calls().some(call => call.method === "initialize"), { timeout: 20_000 }).toBe(true);
    const { routine } = await api("POST", "/api/routines", {
      name: "Source holder", prompt: "Hold the slot.", target: "bot", botId: bot.id, runOn: "maus", enabled: true,
      schedule: { type: "daily", time: "23:00" },
    });
    try {
      await api("POST", `/api/routines/${routine.id}/run`);
      await expect.poll(async () => (await tasks()).some(task => task.threadId !== threadId && task.busy), { timeout: 20_000 }).toBe(true);
      await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
      writeFileSync(gateFile, "");
      await expect.poll(journal, { timeout: 20_000 }).toEqual([{ status: "pending" }]);
      await applyPolicy(["claudeAgent"]);
      writeFileSync(holderGate, "");
      await expect.poll(backupPrompts, { timeout: 20_000 }).toHaveLength(1);
      await expect.poll(async () => (await tasks()).some(task => task.busy), { timeout: 20_000 }).toBe(false);
      await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
      const final = await messages();
      evidence.push({ final, tasks: await tasks() });
      expect(final.filter(message => message.tool?.name.startsWith("notice:"))).toHaveLength(0);
      expect(final.filter(message => message.tool?.name.startsWith("recovery:"))).toHaveLength(1);
      expect(final.filter(message => message.role === "user" && message.text === "RECOVER_FROM_REFUSED_SOURCE")).toHaveLength(1);
      expect((await tasks()).find(task => task.threadId === threadId)?.modelSelection).toEqual(backup);
    } finally {
      writeFileSync(holderGate, "");
      await api("DELETE", `/api/routines/${routine.id}`);
    }
  });
}, 90_000);
