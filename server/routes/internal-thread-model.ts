import { z } from "zod";
import { chiefSetsThreadModel } from "../chief-of-staff.ts";
import type { BotRecord, Store } from "../store.ts";
import type { ThreadModelRequestService } from "../thread-model-requests.ts";
import type { ThreadModelReceipt } from "../model-control-host.ts";
import type { appendDecision } from "../decision-log.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface InternalThreadModelDeps {
  store: Store;
  sender: BotRecord;
  sourceThreadId: string;
  readInternalBody(): Promise<Record<string, unknown>>;
  readable(sourceThreadId: string, targetThreadId: string): boolean;
  connectorThread(botId: string, threadId: string): { group?: unknown } | null;
  requests: ThreadModelRequestService;
  receipt(botId: string, threadId: string): ThreadModelReceipt;
  decide(row: Parameters<typeof appendDecision>[1]): void;
}

/** Dispatch only inside the active internal-capability gate; body reads revalidate its sender and generation. */
export function createInternalThreadModelRoutes(deps: InternalThreadModelDeps): RouteHandler {
  const { store, sender, sourceThreadId, readInternalBody, readable, connectorThread, requests, receipt, decide } = deps;
  return async ({ res, path, method, json }) => {
    if (method === "POST" && path === "/api/internal/thread-model-state") {
      const body = await readInternalBody();
      const threadId = typeof body.targetThreadId === "string" ? body.targetThreadId : "";
      const target = store.botByThread(threadId);
      const task = target && store.taskByThread(target.id, threadId);
      if (!target || !task || !readable(sourceThreadId, threadId)) {
        return json(res, 404, { error: "no such accessible conversation" });
      }
      const refusal = chiefSetsThreadModel(sender, task, task.openedBy ? store.bot(task.openedBy.botId) : undefined, target);
      if (refusal) return json(res, 403, { error: refusal });
      return json(res, 200, receipt(target.id, threadId));
    }
    if (method !== "POST" || path !== "/api/internal/thread-model-requests") return PASS;
    const parsed = z.object({
      fromBotId: z.string().min(1).max(128),
      fromThreadId: z.string().min(1).max(128),
      targetThreadId: z.string().min(1).max(128),
      modelSelection: z.unknown(),
      reason: z.unknown(),
    }).strict().safeParse(await readInternalBody());
    if (!parsed.success) return json(res, 400, { error: "invalid thread model proposal" });
    const body = parsed.data;
    const from = store.bot(body.fromBotId);
    if (!from) return json(res, 403, { error: "unknown sender" });
    const owner = connectorThread(from.id, body.fromThreadId);
    if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
    if (!readable(body.fromThreadId, body.targetThreadId)) {
      return json(res, 404, { error: "no such accessible conversation" });
    }
    const proposed = requests.submit({
      botId: from.id, threadId: body.fromThreadId, targetThreadId: body.targetThreadId,
      selection: body.modelSelection, reason: body.reason,
      from: owner.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
    });
    decide({
      threadId: body.fromThreadId, requestId: proposed.requestId, botId: from.id, botName: from.name,
      tool: "set_thread_model", summary: proposed.detail, decision: proposed.state === "applied" ? "auto-approved" : "card-shown",
      source: proposed.state === "applied" ? proposed.appliedBy ?? "full-access" : "model",
    });
    const target = store.botByThread(body.targetThreadId)!;
    return json(res, 201, { ...proposed, receipt: receipt(target.id, body.targetThreadId) });
  };
}
