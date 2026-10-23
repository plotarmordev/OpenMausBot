import type { MaintenanceLease } from "../maintenance-lease.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface MaintenanceLeaseRouteDeps {
  lease: MaintenanceLease;
  /** Who is still working: a bot's or room's name, "" when it has none; null when nothing is. */
  busy(): string | null;
  /** Runs after a lease ends by release, so work held back can start. */
  released(): void;
}

export function createMaintenanceLeaseRoutes({ lease, busy, released }: MaintenanceLeaseRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const matched = path.match(/^\/api\/maintenance\/lease(?:\/(renew|check|release))?$/);
    if (!matched) return PASS;
    const action = matched[1] ?? "";
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only this server's owner can hold maintenance." });
    if (!action && method === "GET") {
      const current = lease.current();
      return json(res, 200, current ? { held: true, lease: current } : { held: false });
    }
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, 4096) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { code: "invalid", error: "body must be a JSON object" });
    const outcome = action === "renew" ? lease.renew({ token: body.token, ttlMs: body.ttlMs })
      : action === "check" ? lease.check(body.token)
      : action === "release" ? lease.release(body.token)
      : lease.acquire({ token: body.token, holder: body.holder, ttlMs: body.ttlMs }, busy);
    const { ok: _ok, status, ...answer } = outcome;
    json(res, status, answer);
    if (action === "release" && outcome.ok && outcome.state === "released" && !outcome.replayed) released();
  };
}