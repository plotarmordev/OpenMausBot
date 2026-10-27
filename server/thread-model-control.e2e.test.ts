import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

type Selection = { instanceId: string; model: string; effort: string };
type NativeReceipt = { method: string; sessionId?: string; marker?: string; markers?: string[]; model?: string; variant?: string; cwd?: string; configId?: string; value?: string };
const engineId = "thread-model-control-fixture";
const original: Selection = { instanceId: engineId, model: "glm-5.3", effort: "low" };
const selected: Selection = { instanceId: engineId, model: "glm-5.3-flash", effort: "medium" };
const capabilityKey = "isolated-thread-model-control";
const botSchema = z.object({ id: z.string(), threadId: z.string().optional(), activeTaskId: z.string().optional() }).passthrough();
type FixtureBot = z.infer<typeof botSchema> & { activeTaskId: string };
const taskSchema = z.object({ threadId: z.string(), cwd: z.string().optional(), busy: z.boolean() }).passthrough();
const receiptSchema = z.object({
  botDefault: z.unknown(), taskOverride: z.unknown(), currentExecution: z.unknown(), nextTurn: z.unknown(), dispatched: z.boolean(),
}).passthrough();
const resultSchema = z.object({
  status: z.string().optional(), success: z.boolean().optional(), bot: botSchema.optional(),
  state: z.string().optional(), requestId: z.string().optional(), receipt: receiptSchema.optional(),
  botDefault: z.unknown().optional(), taskOverride: z.unknown().optional(), currentExecution: z.unknown().optional(), nextTurn: z.unknown().optional(),
}).passthrough();

it("changes blocked, self and busy task models without dispatch, with explicit retry, authorization and Undo", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const nativeDir = join(dataDir, "thread-model-control");
  const cwd = join(dataDir, "retained-project");
  mkdirSync(nativeDir);
  mkdirSync(cwd);
  const artifact = join(cwd, "retained-artifact.txt");
  writeFileSync(artifact, "Preserve this task artifact.\n");
  const evidence: unknown[] = [{ provider: "Offline synthetic ACP; not live provider evidence" }];
  let child: ChildProcess | undefined;
  const receipts = (): NativeReceipt[] => {
    const path = join(nativeDir, "receipts.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const prompts = () => receipts().filter((entry) => entry.method === "session/prompt");
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = resultSchema.parse(await response.json());
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const mint = async (bot: FixtureBot) => {
    const response = await fetch(`${url}/api/testing/internal-capability`, {
      method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": capabilityKey },
      body: JSON.stringify({ botId: bot.id, threadId: bot.activeTaskId, kind: "agents" }),
    });
    expect(response.status).toBe(201);
    return z.object({ token: z.string() }).parse(await response.json()).token;
  };
  const control = async (...args: string[]) => {
    const result = resultSchema.parse(await runControlOmb([...args, "--url", url]));
    evidence.push({ command: args, result });
    return result;
  };
  const messages = async (threadId: string) => z.array(z.object({
    id: z.string(), role: z.string(), text: z.string().optional(),
  }).passthrough()).parse((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages);
  const botNow = async (id: string) => z.array(botSchema.extend({
    tasks: z.array(taskSchema),
  })).parse((await api("GET", "/api/bots")).bots).find((bot) => bot.id === id)!;
  const taskNow = async (bot: FixtureBot) => (await botNow(bot.id)).tasks.find((task) => task.threadId === bot.activeTaskId)!;
  const settled = async (bot: FixtureBot, status = "settled") => {
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe(status);
    await expect.poll(async () => (await taskNow(bot)).busy, { timeout: 10_000 }).toBe(false);
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const fakeCli = fileURLToPath(new URL("./testing/fake-custom-acp-models.ts", import.meta.url));
    config.instances[engineId] = { driver: "customAcp", displayName: "Thread model control fixture",
      config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fakeCli)}` },
      environment: { FAKE_CUSTOM_ACP_DIRECTORY: nativeDir } };
    writeFileSync(configPath, JSON.stringify(config));
    const start = async () => {
      const log = openSync(logPath, "a", 0o600);
      child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: capabilityKey },
        stdio: ["ignore", log, log],
      });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 25_000 }).toBe(true);
    };
    await start();
    await api("POST", `/api/instances/${engineId}/refresh-models`, {});
    for (const bot of z.array(botSchema).parse((await api("GET", "/api/bots")).bots).filter((bot) => bot.chiefOfStaff)) {
      await api("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: false });
    }
    const create = async (name: string, section: string) => {
      const created = botSchema.parse((await control("new-bot", "--name", name, "--section", section)).bot);
      const activeTaskId = created.activeTaskId ?? created.threadId;
      if (!activeTaskId) throw new Error("new-bot did not return its active conversation");
      const bot: FixtureBot = { ...created, activeTaskId };
      await api("PATCH", `/api/bots/${bot.id}`, { cwd });
      await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, {
        modelSelection: original, updateBotDefault: true, requireAvailableModel: true,
      });
      return bot;
    };
    const worker = await create("Model worker", "Model control");
    expect((await control("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "ACP_PICKER_CONTEXT Preserve my existing context and artifact.")).success).toBe(true);
    await settled(worker);
    writeFileSync(join(nativeDir, "quota"), "blocked");
    await control("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "ACP_PICKER_QUOTA Continue the existing task.");
    await settled(worker, "failed");
    expect(JSON.stringify(await messages(worker.activeTaskId))).toMatch(/quota|usage.limit|weekly limit/i);
    const chief = await create("Model Chief", "Model control");
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const outsider = await create("Other team worker", "Other team");
    const personStarted = await create("Person-started teammate", "Model control");
    // Seed only the stopped disposable store: the positive case represents a task opened by this Chief.
    await waitForExit(child, { signal: "SIGTERM" });
    const botsPath = join(dataDir, "bots.json");
    const saved = z.array(z.object({
      id: z.string(), tasks: z.array(z.object({ threadId: z.string() }).passthrough()),
    }).passthrough()).parse(JSON.parse(readFileSync(botsPath, "utf8")));
    const seededTask = saved.find((bot) => bot.id === worker.id)!.tasks.find((task) => task.threadId === worker.activeTaskId)!;
    seededTask.openedBy = { botId: chief.id, name: "Model Chief", threadId: chief.activeTaskId, kind: "work" };
    writeFileSync(botsPath, JSON.stringify(saved));
    await start();
    expect((await taskNow(worker)).openedBy).toMatchObject({ botId: chief.id, threadId: chief.activeTaskId, kind: "work" });
    let token = await mint(chief);
    const source = { fromBotId: chief.id, fromThreadId: chief.activeTaskId };
    const state = (threadId: string, status = 200) => api("POST", "/api/internal/thread-model-state", { targetThreadId: threadId }, status, token);
    const set = (threadId: string, modelSelection: unknown, status = 201) => api("POST", "/api/internal/thread-model-requests", {
      ...source, targetThreadId: threadId, modelSelection, reason: "Explicit fixture model change; do not resume",
    }, status, token);
    const assertIdleReceipt = (receipt: unknown, value: Selection) => {
      expect(receipt).toMatchObject({ currentExecution: null, nextTurn: { selection: value, scope: "next_turn", resolved: false }, dispatched: false });
    };
    const before = await messages(worker.activeTaskId);
    const beforeTask = await taskNow(worker);
    const beforePrompts = prompts();
    const changed = await set(worker.activeTaskId, selected);
    expect(changed.state).toBe("applied");
    assertIdleReceipt(changed.receipt, selected);
    expect(changed.receipt).toMatchObject({ botDefault: original, taskOverride: selected });
    expect(await state(worker.activeTaskId)).toEqual(changed.receipt);
    expect(await messages(worker.activeTaskId)).toEqual(before);
    expect(await taskNow(worker)).toMatchObject({ threadId: beforeTask.threadId, cwd: beforeTask.cwd, busy: false });
    expect(readFileSync(artifact, "utf8")).toBe("Preserve this task artifact.\n");
    expect(prompts()).toEqual(beforePrompts);

    const unchanged = await state(worker.activeTaskId);
    const savedBots = readFileSync(join(dataDir, "bots.json"), "utf8");
    for (const value of [{ ...selected, model: "not-in-catalog" }, { ...selected, effort: "not-supported" }, { ...selected, instanceId: "missing-instance" }]) {
      await set(worker.activeTaskId, value, 400);
      expect(await state(worker.activeTaskId)).toEqual(unchanged);
      expect(readFileSync(join(dataDir, "bots.json"), "utf8")).toBe(savedBots);
    }
    await set(outsider.activeTaskId, selected, 403);
    await state(outsider.activeTaskId, 403);
    await set(personStarted.activeTaskId, selected, 403);
    expect((await taskNow(personStarted)).openedBy).toBeUndefined();
    await set("unknown-thread", selected, 404);
    expect(readFileSync(join(dataDir, "bots.json"), "utf8")).toBe(savedBots);
    expect(prompts()).toEqual(beforePrompts);

    await api("POST", `/api/threads/${chief.activeTaskId}/undo`, { requestId: changed.requestId });
    assertIdleReceipt(await state(worker.activeTaskId), original);
    expect((await state(worker.activeTaskId)).taskOverride).toBeNull();
    expect(prompts()).toEqual(beforePrompts);
    await set(worker.activeTaskId, selected);
    unlinkSync(join(nativeDir, "quota"));
    const retryStart = receipts().length;
    expect(await api("POST", "/api/internal/retry-thread", { ...source, toBotId: worker.id, toThreadId: worker.activeTaskId }, 200, token)).toMatchObject({ started: true });
    await settled(worker);
    const retried = receipts().slice(retryStart).filter((entry) => entry.method === "session/prompt");
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ model: selected.model, variant: selected.effort, cwd });
    expect(receipts().slice(retryStart)).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "session/set_config_option", sessionId: retried[0].sessionId, configId: "thinking", value: selected.effort }),
    ]));
    const after = await messages(worker.activeTaskId);
    for (const message of before) {
      expect(after.find((entry) => entry.id === message.id)).toMatchObject({ role: message.role, ...(message.text === undefined ? {} : { text: message.text }) });
    }
    expect(after.some((message) => message.role === "bot" && message.text?.includes(`:${selected.model}:${selected.effort}`))).toBe(true);
    expect(readFileSync(artifact, "utf8")).toBe("Preserve this task artifact.\n");

    const selfBefore = await state(chief.activeTaskId);
    const selfChange = await set(chief.activeTaskId, selected);
    assertIdleReceipt(selfChange.receipt, selected);
    expect(receiptSchema.parse(selfChange.receipt).botDefault).toEqual(original);
    const defaultChange = await api("POST", "/api/internal/model-requests", { ...source, forBotId: chief.id, modelSelection: selected, reason: "Explicitly change my default only" }, 201, token);
    expect(defaultChange.state).toBe("applied");
    expect(defaultChange.receipt).toMatchObject({ botDefault: selected, taskOverride: selected, currentExecution: null, dispatched: false });
    const temporarySelfChange = await set(chief.activeTaskId, original);
    await api("POST", `/api/threads/${chief.activeTaskId}/undo`, { requestId: temporarySelfChange.requestId });
    expect(await state(chief.activeTaskId)).toMatchObject({ botDefault: selected, taskOverride: selected, currentExecution: null, dispatched: false });
    const followDefault = await set(chief.activeTaskId, selected);
    expect(followDefault.receipt).toMatchObject({ botDefault: selected, taskOverride: null, currentExecution: null, dispatched: false });
    expect((await set(chief.activeTaskId, selected, 400)).error).toMatch(/Nothing would change/);
    await api("POST", `/api/threads/${chief.activeTaskId}/undo`, { requestId: followDefault.requestId });
    expect((await state(chief.activeTaskId)).taskOverride).toEqual(selected);
    expect(prompts()).toEqual([...beforePrompts, ...retried]);
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "ACP_PICKER_SELF_SELECTED Execute my explicit self selection.");
    await settled(chief);
    expect(prompts().at(-1)).toMatchObject({ marker: "ACP_PICKER_SELF_SELECTED", model: selected.model, variant: selected.effort, cwd });
    token = await mint(chief);
    await api("POST", `/api/threads/${chief.activeTaskId}/undo`, { requestId: defaultChange.requestId });
    expect((await state(chief.activeTaskId)).botDefault).toEqual(original);
    expect((await state(chief.activeTaskId)).taskOverride).toEqual(selected);
    await api("POST", `/api/threads/${chief.activeTaskId}/undo`, { requestId: selfChange.requestId });
    expect(await state(chief.activeTaskId)).toEqual(selfBefore);
    await control("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "ACP_PICKER_SELF_RESTORED Execute my restored selection.");
    await settled(chief);
    expect(prompts().at(-1)).toMatchObject({ marker: "ACP_PICKER_SELF_RESTORED", model: original.model, variant: original.effort, cwd });
    token = await mint(chief);

    const busyStart = receipts().length;
    await control("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "ACP_PICKER_BUSY Keep this execution on its original choice.");
    await expect.poll(() => receipts().slice(busyStart).some((entry) => entry.method === "session/prompt" && entry.marker === "ACP_PICKER_BUSY"), { timeout: 20_000 }).toBe(true);
    const running = await state(worker.activeTaskId);
    expect(running.currentExecution).toMatchObject({ selection: selected, model: selected.model, effort: selected.effort, scope: "current_turn" });
    const busyChange = await set(worker.activeTaskId, original);
    const busyReceipt = receiptSchema.parse(busyChange.receipt);
    expect(busyReceipt.currentExecution).toEqual(running.currentExecution);
    expect(busyReceipt.nextTurn).toEqual({ selection: original, scope: "next_turn", resolved: false });
    expect(busyReceipt.dispatched).toBe(false);
    expect((await taskNow(worker)).busy).toBe(true);
    expect(receipts().slice(busyStart).filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
    writeFileSync(join(nativeDir, "release-busy"), "finish");
    await settled(worker);
    expect((await messages(worker.activeTaskId)).some((message) => message.text === `fixture:ACP_PICKER_BUSY:${selected.model}:${selected.effort}`)).toBe(true);
    assertIdleReceipt(await state(worker.activeTaskId), original);
    await control("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "ACP_PICKER_NEXT Run the explicitly requested next turn.");
    await settled(worker);
    expect(prompts().at(-1)).toMatchObject({ marker: "ACP_PICKER_NEXT", model: original.model, variant: original.effort, cwd });
    token = await mint(chief);
    assertIdleReceipt(await state(worker.activeTaskId), original);
  } finally {
    const evidencePath = `${logPath}.thread-model-control.json`;
    writeFileSync(evidencePath, JSON.stringify({ evidence, receipts: receipts() }, null, 2));
    await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 180_000);
