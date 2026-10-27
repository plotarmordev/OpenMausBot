import { parseToolScope, toolScopeWidens } from "../shared/tool-scope.ts";
import { soulHash, writeSoulMirror } from "./bot-folder.ts";
import type { BotProfilePatch } from "./bot-profile.ts";
import { parseConnectorTools } from "./connector-tools.ts";
import { newId, type ModelSelection } from "./contracts.ts";
import { soulRevision } from "./profile-revision.ts";
import type { BotRecord, SoulCompareAndSetResult, SoulWriteReceipt, Store, StoreChange, TaskRecord } from "./store.ts";

interface ProfileWriteHost {
  store: Pick<Store, "bots" | "bot" | "activeTask">;
  saveBots(bots?: BotRecord[]): void;
  emit(change: StoreChange): void;
  switchNeedsAsk(botId: string, threadId: string, from: ModelSelection, to: ModelSelection): boolean;
  taskCountsAsBotUnread(task: TaskRecord): boolean;
  askNow: Pick<TaskRecord, "approvalMode" | "autoApprove" | "alwaysAllow">;
  receiptLimit: number;
}

/** Profile commits are durable-first; ordinary patches retain memory-first revocations. */
export class StoreProfileWrites {
  private readonly host: ProfileWriteHost;
  constructor(host: ProfileWriteHost) {
    this.host = host;
  }

  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null {
    const bot = this.host.store.bot(id);
    if (!bot) return null;
    if (patch.soul !== undefined) patch = { ...patch, soulWriteId: newId() };
    if (patch.connectorTools !== undefined) {
      const parsed = parseConnectorTools(patch.connectorTools);
      if (!parsed.ok) throw new Error(parsed.error);
      patch = { ...patch, connectorTools: parsed.grants };
    }
    if (Object.hasOwn(patch, "toolScope")) {
      const parsed = parseToolScope(patch.toolScope);
      if (!parsed.ok) throw new Error(parsed.error);
      patch = { ...patch, toolScope: parsed.scope };
    }
    const wideningToolScope = Object.hasOwn(patch, "toolScope") && toolScopeWidens(bot.toolScope, patch.toolScope);
    const nextToolScope = patch.toolScope;
    if (wideningToolScope) {
      patch = { ...patch };
      delete patch.toolScope;
    }
    const toAsk = patch.modelSelection ? (bot.tasks ?? []).filter((task) => task.modelSelection === undefined &&
      this.host.switchNeedsAsk(id, task.threadId, bot.modelSelection, patch.modelSelection!)) : [];
    // Revocations take effect in memory even when the disk write fails.
    Object.assign(bot, patch);
    for (const task of toAsk) Object.assign(task, structuredClone(this.host.askNow));
    const task = this.host.store.activeTask(id);
    if (task) {
      for (const key of ["resumeCursors", "rewound", "pinnedMessageId", "unread"] as const) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          Object.assign(task, { [key]: structuredClone(patch[key]) });
        }
      }
      bot.unread = bot.tasks!.some(this.host.taskCountsAsBotUnread);
    }
    if (wideningToolScope) {
      // New authority goes live only after its durable save succeeds.
      this.host.saveBots(this.host.store.bots.map((candidate) => candidate === bot ? { ...bot, toolScope: nextToolScope } : candidate));
      bot.toolScope = nextToolScope;
    } else this.host.saveBots();
    this.host.emit({ type: "bot", botId: id });
    return bot;
  }

  patchBotProfile(id: string, patch: BotProfilePatch & Partial<Pick<BotRecord, "cwd" | "lastProfileRequestId">>): BotRecord | null {
    const bot = this.host.store.bot(id);
    return bot ? this.commitProfile(bot, patch) : null;
  }

  compareAndSetSoul(id: string, input: { soul: string; expectedRevision: string; requestId: string }): SoulCompareAndSetResult {
    const bot = this.host.store.bot(id);
    if (!bot) return { state: "missing" };
    const currentRevision = soulRevision(bot);
    const prior = bot.soulWrites?.find((receipt) => receipt.requestId === input.requestId);
    if (prior?.state === "voided") return { state: "voided" };
    if (prior) {
      return prior.from === input.expectedRevision && prior.soulSha256 === soulHash(input.soul)
        ? { state: "replayed", receipt: prior, currentRevision }
        : { state: "reused" };
    }
    if (currentRevision !== input.expectedRevision) return { state: "conflict", currentRevision };
    let receipt: Extract<SoulWriteReceipt, { state: "applied" }> | undefined;
    const updated = this.commitProfile(bot, { soul: input.soul }, (next) => (receipt = {
      requestId: input.requestId, state: "applied", from: currentRevision, to: soulRevision(next), soulSha256: soulHash(input.soul), at: Date.now(),
    }));
    return { state: "applied", bot: updated, receipt: receipt! };
  }

  voidSoulWrite(id: string, requestId: string): SoulWriteReceipt | null {
    const bot = this.host.store.bot(id);
    if (!bot) return null;
    const prior = bot.soulWrites?.find((receipt) => receipt.requestId === requestId);
    if (prior) return prior;
    const voided: SoulWriteReceipt = { requestId, state: "voided", at: Date.now() };
    const next = { ...bot, soulWriteId: newId(), ...this.withSoulReceipt(bot, voided) };
    this.host.saveBots(this.host.store.bots.map((candidate) => candidate.id === id ? next : candidate));
    Object.assign(bot, next);
    return voided;
  }

  soulWriteReceipt(id: string, requestId: string): SoulWriteReceipt | null {
    return this.host.store.bot(id)?.soulWrites?.find((receipt) => receipt.requestId === requestId) ?? null;
  }

  private withSoulReceipt(bot: BotRecord, receipt: SoulWriteReceipt): Pick<BotRecord, "soulWrites" | "soulWritesTrimmedAt"> {
    const all = [...(bot.soulWrites ?? []), receipt];
    const dropped = all.slice(0, -this.host.receiptLimit);
    return {
      soulWrites: all.slice(-this.host.receiptLimit),
      ...(dropped.length ? { soulWritesTrimmedAt: Math.max(bot.soulWritesTrimmedAt ?? 0, ...dropped.map((entry) => entry.at)) } : {}),
    };
  }

  private commitProfile(bot: BotRecord, patch: Partial<BotRecord>, receipt?: (next: BotRecord) => SoulWriteReceipt): BotRecord {
    const next = { ...bot, ...patch };
    if (patch.soul !== undefined) {
      next.soulHash = soulHash(patch.soul);
      next.soulDrift = false;
      next.soulWriteId = newId();
    }
    if (receipt) Object.assign(next, this.withSoulReceipt(bot, receipt(next)));
    this.host.saveBots(this.host.store.bots.map((candidate) => candidate.id === bot.id ? next : candidate));
    Object.assign(bot, next);
    if (patch.soul !== undefined) {
      try { writeSoulMirror(bot.id, patch.soul); } catch (e) {
        console.warn(`[bot-folder] could not write SOUL.md mirror for ${bot.id}: ${(e as Error).message}`);
      }
    }
    this.host.emit({ type: "bot", botId: bot.id });
    return bot;
  }
}
