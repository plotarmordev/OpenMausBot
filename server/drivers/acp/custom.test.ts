import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { CustomAcpDriver } from "./custom.ts";
import { removeTempDir } from "../../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("CustomAcpDriver config", () => {
  it("teaches instead of ENOENT when the command is missing or blank", async () => {
    expect(() => CustomAcpDriver.decodeConfig({})).toThrow(/Set CLI|config\.json/);
    expect(() => CustomAcpDriver.decodeConfig({ cli: "   " })).toThrow(/<your-agent> acp/);
    await expect(
      CustomAcpDriver.create({
        instanceId: "custom-blank",
        displayName: undefined,
        environment: {},
        enabled: true,
        config: CustomAcpDriver.defaultConfig(),
      }),
    ).rejects.toThrow(/<your-agent> acp/);
  });

  it("keeps a real command verbatim, wrapper strings included", () => {
    expect(CustomAcpDriver.decodeConfig({ cli: "fx acp", fullAuto: true })).toMatchObject({
      cli: "fx acp",
      fullAuto: true,
    });
  });

  it("advertises the custom rail, multi-instance, and the passthrough model", () => {
    expect(CustomAcpDriver.metadata).toMatchObject({
      access: "custom",
      supportsMultipleInstances: true,
    });
    expect(CustomAcpDriver.models).toEqual({
      default: "agent-default",
      options: [{ id: "agent-default", label: "Agent default", custom: true }],
    });
    expect(CustomAcpDriver.install).toBeUndefined();
  });
});

describe("CustomAcpDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await CustomAcpDriver.create({
      instanceId: "custom-test",
      displayName: "Custom Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-custom-acp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE;
    delete process.env.FAKE_ACP_DUMP;
    delete process.env.XAI_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs a full turn through an arbitrary ACP CLI with canonical events", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-custom", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed",
      "item.started",
      "item.completed",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "customAcp")).toBe(true);
    const text = recorder.events.find((e) => e.type === "item.completed" && (e as { itemType?: string }).itemType === "assistant_text")!;
    expect((text as { text?: string }).text).toBe("hello from fake acp");
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true });
  });

  it("passes instance env to the child but strips foreign provider keys", async () => {
    process.env.XAI_API_KEY = "xai-should-not-leak";
    const dump = join(scratch, "dump.json");
    process.env.FAKE_ACP_DUMP = dump;
    await create({ MY_AGENT_TOKEN: "tok-123" });
    await instance.adapter.sendTurn({ threadId: "t-custom-env", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8")) as { env: Record<string, string | undefined> };
    expect(seen.env.MY_AGENT_TOKEN).toBe("tok-123");
    expect(seen.env.XAI_API_KEY).toBeUndefined();
  });

  const thoughtConfig = JSON.stringify({
    "model-one": { currentValue: "medium", options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
    "model-two": { id: "reasoning_effort", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  });

  it("selects model and effort before prompting and switches back in the same conversation", async () => {
    const dump = join(scratch, "selection");
    await create({ FAKE_ACP_MODELS: "model-one,model-two", FAKE_ACP_VARIANTS: thoughtConfig, FAKE_ACP_DUMP: dump });
    for (const selection of [
      { model: "agent-default", effort: "high", actual: "model-one" },
      { model: "model-two", effort: "low", actual: "model-two" },
      { model: "model-one", effort: "medium", actual: "model-one" },
    ] as const) {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "selection", text: "hi", model: selection.model, effort: selection.effort });
      expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ ok: true });
      expect(recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId))
        .toMatchObject({ model: selection.actual, effort: selection.effort });
    }
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(calls.map((call: { params: unknown }) => call.params)).toEqual([
      { sessionId: "fake-acp-session", configId: "effort", value: "high" },
      { sessionId: "fake-acp-session", configId: "model", value: "model-two" },
      { sessionId: "fake-acp-session", configId: "reasoning_effort", value: "low" },
      { sessionId: "fake-acp-session", configId: "model", value: "model-one" },
      { sessionId: "fake-acp-session", configId: "effort", value: "medium" },
    ]);
    const prompts = readFileSync(`${dump}.prompts.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(prompts.map((prompt) => prompt.model)).toEqual(["model-one", "model-two", "model-one"]);
    expect(new Set(prompts.map((prompt) => prompt.sessionId)).size).toBe(1);
  });

  it.each([
    { model: "agent-default", effort: "max" as const },
    { model: "model-two", effort: "medium" as const },
    { model: "model-one", effort: "high" as const, variant: "medium" },
  ])("rejects unsupported or conflicting effort before prompt: %j", async (selection) => {
    const dump = join(scratch, "unsupported");
    await create({ FAKE_ACP_MODELS: "model-one,model-two", FAKE_ACP_VARIANTS: thoughtConfig, FAKE_ACP_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "unsupported", text: "hi", ...selection });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    expect(existsSync(`${dump}.prompts.jsonl`)).toBe(false);
  });

  it("rejects an unconfirmed effort setter without claiming the requested effort", async () => {
    const dump = join(scratch, "stuck");
    await create({ FAKE_ACP_MODELS: "model-one", FAKE_ACP_VARIANTS: thoughtConfig, FAKE_ACP_VARIANT_STICKS: "1", FAKE_ACP_DUMP: dump });
    await instance.adapter.sendTurn({ threadId: "stuck", text: "hi", model: "agent-default", effort: "high" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({ model: "model-one", effort: "medium" });
    expect(existsSync(`${dump}.prompts.jsonl`)).toBe(false);
  });

  it("does not resolve agent-default without native model evidence", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "unknown-model", text: "hi", model: "agent-default" });
    await recorder.until((e) => e.type === "turn.completed");
    const started = recorder.events.find((e) => e.type === "session.started");
    expect(started).toMatchObject({ model: null });
    expect(started).not.toHaveProperty("effort");
  });

  it("reports available with a working CLI and no sign-in requirement", async () => {
    await create();
    const snapshot = await instance.snapshot();
    expect(snapshot).toMatchObject({ state: "available" });
  });
});
