import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export const MAINTENANCE_LEASE_FILE = "maintenance-lease.json";
export const MAINTENANCE_LEASE_MIN_TTL_MS = 5_000;
export const MAINTENANCE_LEASE_MAX_TTL_MS = 30 * 60_000;
const ENDED_KEPT = 32;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
/** A state file that exists but cannot be read may hide a live lease; no lease outlives MAX_TTL past its last renewal. */
export const UNREADABLE_LEASE_ID = "unreadable";

export interface MaintenanceLeaseView { leaseId: string; holder: string; acquiredAt: number; expiresAt: number }
export type MaintenanceLeaseEnd = "released" | "expired";

export type MaintenanceLeaseOutcome =
  | { ok: true; status: 200 | 201; state: "held"; lease: MaintenanceLeaseView; remainingMs: number; replayed?: true }
  | { ok: true; status: 200; state: MaintenanceLeaseEnd; leaseId: string; replayed?: true }
  | { ok: false; status: 400; code: "invalid"; error: string }
  | { ok: false; status: 409; code: "busy"; error: string; busy: string }
  | { ok: false; status: 409; code: "lease-held"; error: string; lease: MaintenanceLeaseView }
  | { ok: false; status: 409; code: "lease-ended"; error: string; ended: MaintenanceLeaseEnd; leaseId: string }
  | { ok: false; status: 409; code: "lease-not-held"; error: string };

/** One exclusive, expiring lease for a deployment controller. While it is held no turn starts; its holder proves itself
 * with the token it chose at acquisition. Security invariant: only the token's SHA-256 is kept, in memory and on disk. */
export interface MaintenanceLease {
  current(): MaintenanceLeaseView | null;
  /** Why no turn may start now, or null. */
  refusal(): string | null;
  /** Throws `refusal()` as a 503 with code "maintenance". */
  assertTurns(): void;
  /** `busy` names who is still working ("" when unnamed) or is null when nothing is; it runs after every other check,
   * in the same synchronous step as the grant. */
  acquire(input: { token: unknown; holder: unknown; ttlMs: unknown }, busy: () => string | null): MaintenanceLeaseOutcome;
  renew(input: { token: unknown; ttlMs: unknown }): MaintenanceLeaseOutcome;
  check(token: unknown): MaintenanceLeaseOutcome;
  /** Idempotent for the token that held it: a retry answers how that lease ended. */
  release(token: unknown): MaintenanceLeaseOutcome;
}

const heldSchema = z.object({
  leaseId: z.string().min(1), holder: z.string(), acquiredAt: z.number(), expiresAt: z.number(), tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
});
const stateSchema = z.object({
  v: z.literal(1),
  lease: heldSchema.nullable(),
  ended: z.array(z.object({ tokenHash: z.string(), leaseId: z.string(), reason: z.enum(["released", "expired"]), at: z.number() })),
});
type HeldLease = z.infer<typeof heldSchema>;
type LeaseState = Omit<z.infer<typeof stateSchema>, "v">;
type Ownership = { lease: HeldLease; hash: string; refused?: undefined } | { refused: MaintenanceLeaseOutcome };

export function createMaintenanceLease({ dataDir, now = Date.now }: { dataDir: string; now?: () => number }): MaintenanceLease {
  const file = join(dataDir, MAINTENANCE_LEASE_FILE);

  const unreadable = (error: unknown): LeaseState => {
    console.warn(`maintenance lease: ${file} could not be read (${(error as Error).message}); refusing turns for ${MAINTENANCE_LEASE_MAX_TTL_MS / 60_000} minutes`);
    const at = now();
    return { lease: { leaseId: UNREADABLE_LEASE_ID, holder: `unknown (${MAINTENANCE_LEASE_FILE} could not be read)`, acquiredAt: at,
      expiresAt: at + MAINTENANCE_LEASE_MAX_TTL_MS, tokenHash: "0".repeat(64) }, ended: [] };
  };
  const state: LeaseState = (() => {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { lease: null, ended: [] } : unreadable(error);
    }
    try {
      const { lease, ended } = stateSchema.parse(JSON.parse(raw));
      return { lease, ended };
    } catch (error) {
      return unreadable(error);
    }
  })();

  const live = (): HeldLease | null => {
    const lease = state.lease;
    if (lease && now() >= lease.expiresAt) {
      state.ended = [...state.ended, { tokenHash: lease.tokenHash, leaseId: lease.leaseId, reason: "expired" as const, at: lease.expiresAt }].slice(-ENDED_KEPT);
      state.lease = null;
    }
    return state.lease;
  };
  const commit = (next: LeaseState): void => {
    writeFileAtomic(file, JSON.stringify({ v: 1, ...next }), { mode: 0o600 });
    state.lease = next.lease;
    state.ended = next.ended;
  };
  const view = ({ leaseId, holder, acquiredAt, expiresAt }: HeldLease): MaintenanceLeaseView => ({ leaseId, holder, acquiredAt, expiresAt });
  const held = (lease: HeldLease, status: 200 | 201 = 200, replayed?: true): MaintenanceLeaseOutcome =>
    ({ ok: true, status, state: "held", lease: view(lease), remainingMs: lease.expiresAt - now(), ...(replayed ? { replayed } : {}) });
  const owned = (token: unknown): Ownership => {
    if (typeof token !== "string" || !TOKEN.test(token)) {
      return { refused: { ok: false, status: 400, code: "invalid", error: "token must be 32-256 characters of A-Z, a-z, 0-9, _ or -" } };
    }
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const lease = live();
    if (lease?.tokenHash === hash) return { lease, hash };
    const ended = state.ended.findLast((entry) => entry.tokenHash === hash);
    if (ended) return { refused: { ok: false, status: 409, code: "lease-ended", error: `this lease was ${ended.reason}`, ended: ended.reason, leaseId: ended.leaseId } };
    return { refused: { ok: false, status: 409, code: "lease-not-held", error: "this token holds no maintenance lease" } };
  };
  const ttl = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= MAINTENANCE_LEASE_MIN_TTL_MS && value <= MAINTENANCE_LEASE_MAX_TTL_MS ? value : null;
  const badTtl: MaintenanceLeaseOutcome = { ok: false, status: 400, code: "invalid", error: `ttlMs must be an integer from ${MAINTENANCE_LEASE_MIN_TTL_MS} to ${MAINTENANCE_LEASE_MAX_TTL_MS}` };
  const refusal = (): string | null => {
    const lease = live();
    return lease ? `OpenMausBot is paused for maintenance by ${lease.holder} until ${new Date(lease.expiresAt).toISOString()}. Try again when it ends.` : null;
  };

  return {
    current() {
      const lease = live();
      return lease ? view(lease) : null;
    },
    refusal,
    assertTurns() {
      const said = refusal();
      if (said) throw Object.assign(new Error(said), { status: 503, code: "maintenance" });
    },
    acquire(input, busy) {
      const ttlMs = ttl(input.ttlMs);
      if (ttlMs === null) return badTtl;
      const holder = typeof input.holder === "string" ? input.holder.trim() : "";
      if (!holder || holder.length > 120) return { ok: false, status: 400, code: "invalid", error: "holder must name the controller in 1-120 characters" };
      const mine = owned(input.token);
      if (!mine.refused) return held(mine.lease, 200, true);
      if (mine.refused.ok || mine.refused.code !== "lease-not-held") return mine.refused;
      const other = live();
      if (other) return { ok: false, status: 409, code: "lease-held", error: `maintenance is already held by ${other.holder}`, lease: view(other) };
      const who = busy();
      if (who !== null) return { ok: false, status: 409, code: "busy", error: "A bot is still working.", busy: who };
      const at = now();
      const lease: HeldLease = { leaseId: randomUUID(), holder, acquiredAt: at, expiresAt: at + ttlMs,
        tokenHash: createHash("sha256").update(input.token as string, "utf8").digest("hex") };
      commit({ lease, ended: state.ended });
      return held(lease, 201);
    },
    renew(input) {
      const ttlMs = ttl(input.ttlMs);
      if (ttlMs === null) return badTtl;
      const mine = owned(input.token);
      if (mine.refused) return mine.refused;
      const lease = { ...mine.lease, expiresAt: now() + ttlMs };
      commit({ lease, ended: state.ended });
      return held(lease);
    },
    check(token) {
      const mine = owned(token);
      return mine.refused ?? held(mine.lease);
    },
    release(token) {
      const mine = owned(token);
      if (!mine.refused) {
        commit({ lease: null, ended: [...state.ended, { tokenHash: mine.hash, leaseId: mine.lease.leaseId, reason: "released" as const, at: now() }].slice(-ENDED_KEPT) });
        return { ok: true, status: 200, state: "released", leaseId: mine.lease.leaseId };
      }
      const refused = mine.refused;
      if (!refused.ok && refused.code === "lease-ended") return { ok: true, status: 200, state: refused.ended, leaseId: refused.leaseId, replayed: true };
      return refused;
    },
  };
}