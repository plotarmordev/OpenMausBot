import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderInstance } from "./contracts.ts";
import { createModelValidation } from "./model-control-host.ts";
import { ModelRequestService } from "./model-requests.ts";
import { Store } from "./store.ts";
import { ThreadModelRequestService } from "./thread-model-requests.ts";
import { TRIAL_KEY_HELD } from "./trial-credit.ts";

const credit: ModelSelection = { instanceId: "trial-credit", model: "claude-sonnet-5" };
const key: ModelSelection = { instanceId: "openrouter", model: "meta-llama/llama-3.3-70b-instruct" };

function harness(initial = credit) {
  const store = new Store(() => initial, undefined, () => "openai-compat");
  const bot = store.createBot();
  const instances = new Map([credit, key].map(selection => [selection.instanceId, {
    instanceId: selection.instanceId, driverKind: "openai-compat", enabled: true,
    models: { default: selection.model, options: [{ id: selection.model, label: selection.model }] },
    adapter: { capabilities: {} },
  } as ProviderInstance]));
  const state = { held: true, immediate: false, policy: undefined as string | undefined };
  const validation = createModelValidation({
    registry: { get: id => instances.get(id) ?? null, cliTarget: () => ({ driverKind: "openai-compat", cli: null }) },
    hostedModels: null, providerInstanceChanging: () => false,
    policyModelRefusal: () => state.policy,
    heldKeyRefusal: id => state.held && id === key.instanceId ? TRIAL_KEY_HELD : undefined,
    bot: id => store.bot(id), threadBusy: () => false, activeGroupTurnForBot: () => undefined,
  });
  const defaults = new ModelRequestService({
    store, autoApply: () => "level",
    validateModel: selection => {
      const checked = validation.checkedNativeModelSelection(selection);
      return checked.ok ? null : checked.error;
    },
  });
  const threads = new ThreadModelRequestService({
    store, autoApply: () => state.immediate ? "level" : null, authorize: () => null,
    checkSwitch: validation.checkedNativeTaskModelSwitch,
  });
  const args = { botId: bot.id, threadId: bot.threadId, reason: "Requested model change" };
  return { store, bot, state, validation, defaults, threads, args };
}

describe("trial-held keys at model-control consumers", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("accepts a held import selection without bypassing catalog, effort, or organization policy", () => {
    const { validation, state } = harness();
    expect(validation.checkedModelSelection(key, undefined, true)).toEqual({ ok: true, selection: key });
    expect(validation.checkedModelSelection({ ...key, model: "missing" }, undefined, true)).toMatchObject({ ok: false, status: 400 });
    expect(validation.checkedModelSelection({ ...key, effort: "high" }, undefined, true)).toMatchObject({ ok: false, status: 400 });
    state.policy = "This engine is disabled by the organization";
    expect(validation.checkedModelSelection(key, undefined, true)).toEqual({ ok: false, status: 403, error: state.policy });
    expect(validation.checkedNativeModelSelection(key)).toEqual({ ok: false, status: 403, error: state.policy });
  });

  it("refuses held default proposals and rechecks the hold at confirmation without writing the default", () => {
    const { store, bot, state, defaults, args } = harness();
    expect(() => defaults.propose({ ...args, selection: key })).toThrow(TRIAL_KEY_HELD);
    expect(store.messagesFor(bot.threadId).some(message => message.card?.modelRequest)).toBe(false);
    state.held = false;
    const proposal = defaults.propose({ ...args, selection: key });
    state.held = true;
    expect(defaults.resolve({ ...args, requestId: proposal.requestId, behavior: "allow" }))
      .toMatchObject({ claimed: true, state: "invalid", error: TRIAL_KEY_HELD });
    expect(store.bot(bot.id)!.modelSelection).toEqual(credit);
    expect(store.messagesFor(bot.threadId).find(message => message.card?.requestId === proposal.requestId)?.card)
      .toMatchObject({ held: TRIAL_KEY_HELD });
  });

  it("refuses default Undo when the previous engine has become held", () => {
    const { store, bot, defaults, args } = harness(key);
    const applied = defaults.submit({ ...args, selection: credit });
    expect(applied.state).toBe("applied");
    expect(defaults.undo({ ...args, requestId: applied.requestId }))
      .toMatchObject({ claimed: true, state: "invalid", error: TRIAL_KEY_HELD });
    expect(store.bot(bot.id)!.modelSelection).toEqual(credit);
  });

  it("refuses held task proposals and rechecks the hold at confirmation without pinning the task", () => {
    const { store, bot, state, threads, args } = harness();
    const request = { ...args, targetThreadId: bot.threadId, selection: key };
    expect(() => threads.submit(request)).toThrow(TRIAL_KEY_HELD);
    expect(store.messagesFor(bot.threadId).some(message => message.card?.threadModelRequest)).toBe(false);
    state.held = false;
    const proposal = threads.submit(request);
    expect(proposal.state).toBe("pending");
    state.held = true;
    expect(threads.resolve({ ...args, requestId: proposal.requestId, behavior: "allow" }))
      .toMatchObject({ claimed: true, state: "invalid", status: 403, error: TRIAL_KEY_HELD });
    expect(store.taskByThread(bot.id, bot.threadId)?.modelSelection).toBeUndefined();
    expect(store.bot(bot.id)!.modelSelection).toEqual(credit);
  });

  it.each([false, true])("refuses task Undo to a held engine with an explicit pin: %s", pinned => {
    const { store, bot, state, threads, args } = harness(pinned ? credit : key);
    state.immediate = true;
    if (pinned) store.switchTaskModel(bot.id, bot.threadId, key, false, false);
    const proposal = threads.submit({ ...args, targetThreadId: bot.threadId, selection: credit });
    expect(proposal.state).toBe("applied");
    expect(threads.undo({ ...args, requestId: proposal.requestId }))
      .toMatchObject({ claimed: true, state: "invalid", status: 403, error: TRIAL_KEY_HELD });
    expect(store.projectBotForTask(bot.id, bot.threadId)!.modelSelection).toEqual(credit);
    expect(store.bot(bot.id)!.modelSelection).toEqual(pinned ? credit : key);
  });
});
