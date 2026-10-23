import type { WireBot } from "../../shared/wire.ts";
import { readSoulDrift } from "../bot-folder.ts";
import { parseBotProfilePatch } from "../bot-profile.ts";
import type { MaintenanceLease } from "../maintenance-lease.ts";
import { profileSnapshot, soulRevision } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import type { BotRecord, SoulWriteReceipt, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotSoulWriteRouteDeps {
  store: Pick<Store, "bot" | "compareAndSetSoul" | "voidSoulWrite" | "soulWriteReceipt">;
  lease: Pick<MaintenanceLease, "check">;
  wireBot(bot: BotRecord): WireBot;
  broadcast(payload: Record<string, unknown>): void;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

const receiptView = (receipt: SoulWriteReceipt) => receipt.state === "applied"
  ? { requestId: receipt.requestId, state: "applied" as const, revision: receipt.to, previousRevision: receipt.from, soulSha256: receipt.soulSha256, at: receipt.at }
  : { requestId: receipt.requestId, state: "voided" as const, at: receipt.at };

export function createBotSoulWriteRoutes({ store, lease, wireBot, broadcast }: BotSoulWriteRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const write = path.match(/^\/api\/bots\/([\w-]+)\/soul\/compare-and-set$/);
    const receipt = path.match(/^\/api\/bots\/([\w-]+)\/soul\/writes\/([\w-]+)(\/void)?$/);
    if (!write && !receipt) return PASS;
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only this server's owner can write standing instructions this way." });

    if (receipt) {
      const [, botId, requestId, voiding] = receipt;
      if (!REQUEST_ID.test(requestId!)) return json(res, 400, { code: "invalid", error: "requestId must be 8-128 characters of A-Z, a-z, 0-9, _ or -" });
      const bot = store.bot(botId!);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (voiding) {
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const settled = store.voidSoulWrite(bot.id, requestId!)!;
        const after = { currentRevision: soulRevision(bot), receiptsTrimmedAt: bot.soulWritesTrimmedAt ?? null };
        return settled.state === "voided"
          ? json(res, 200, { ...receiptView(settled), ...after })
          : json(res, 409, { code: "already-applied", error: "this request already wrote", ...receiptView(settled), ...after });
      }
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      const found = store.soulWriteReceipt(bot.id, requestId!);
      return json(res, 200, { ...(found ? receiptView(found) : { requestId, state: "unknown" }),
        currentRevision: soulRevision(bot), receiptsTrimmedAt: bot.soulWritesTrimmedAt ?? null });
    }

    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { code: "invalid", error: "body must be a JSON object" });
    const { requestId, expectedRevision, leaseToken } = body;
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
      return json(res, 400, { code: "invalid", error: "requestId must be 8-128 characters of A-Z, a-z, 0-9, _ or -" });
    }
    if (typeof expectedRevision !== "string" || !expectedRevision || expectedRevision.length > 200) {
      return json(res, 400, { code: "invalid", error: "expectedRevision must be the soulRevision you read" });
    }
    const parsed = typeof body.soul === "string" ? parseBotProfilePatch({ soul: body.soul }) : null;
    if (!parsed?.ok) return json(res, 400, { code: "invalid", error: parsed ? parsed.error : "soul must be a string" });
    const soul = parsed.patch.soul ?? "";

    const bot = store.bot(write![1]!);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (!store.soulWriteReceipt(bot.id, requestId)) {
      if (leaseToken !== undefined) {
        const held = lease.check(leaseToken);
        if (!held.ok) {
          const { ok: _ok, status, ...why } = held;
          return json(res, status, why);
        }
      }
      const drift = readSoulDrift(bot.id, bot.soul ?? "", bot.soulHash ?? "");
      if (drift.drift) {
        return json(res, 409, { code: "soul-file-drift", error: "SOUL.md was edited outside OpenMausBot; apply or discard that edit first", currentRevision: soulRevision(bot) });
      }
    }
    const before = profileSnapshot(bot);
    const result = store.compareAndSetSoul(bot.id, { soul, expectedRevision, requestId });
    switch (result.state) {
      case "missing": return json(res, 404, { error: "no such bot" });
      case "conflict":
        return json(res, 409, { code: "revision-mismatch", error: "the standing instructions changed since you read them", currentRevision: result.currentRevision });
      case "voided": return json(res, 409, { code: "request-voided", error: "this request was voided and will never write" });
      case "reused": return json(res, 409, { code: "request-id-reused", error: "this requestId already settled with a different soul or expectedRevision" });
      case "replayed":
        return json(res, 200, { ...receiptView(result.receipt), replayed: true, currentRevision: result.currentRevision });
      case "applied": {
        recordProfileChange(bot.id, "user", "compare-and-set", before, profileSnapshot(result.bot));
        const visible = wireBot(result.bot);
        broadcast({ kind: "bot", bot: visible });
        return json(res, 200, { ...receiptView(result.receipt), currentRevision: result.receipt.to });
      }
    }
  };
}