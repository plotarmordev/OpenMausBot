import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createMaintenanceLease, MAINTENANCE_LEASE_FILE, MAINTENANCE_LEASE_MAX_TTL_MS, MAINTENANCE_LEASE_MIN_TTL_MS, UNREADABLE_LEASE_ID,
} from "./maintenance-lease.ts";

const TOKEN = "controller-token-0123456789abcdefghijklmnop";
const OTHER = "competitor-token-0123456789abcdefghijklmnop";
const idle = () => null;

describe("maintenance lease", () => {
  let dir: string;
  let clock: number;
  const open = () => createMaintenanceLease({ dataDir: dir, now: () => clock });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-lease-"));
    clock = 1_000_000;
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is granted only while nothing works, and then refuses every turn", () => {
    const lease = open();
    expect(lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, () => "Capri"))
      .toMatchObject({ ok: false, status: 409, code: "busy", busy: "Capri" });
    expect(lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, () => ""))
      .toMatchObject({ ok: false, code: "busy", busy: "" });
    expect(lease.current()).toBeNull();
    expect(() => lease.assertTurns()).not.toThrow();

    const granted = lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle);
    expect(granted).toMatchObject({ ok: true, status: 201, state: "held", remainingMs: 60_000,
      lease: { holder: "p1b", acquiredAt: clock, expiresAt: clock + 60_000 } });
    expect(() => lease.assertTurns()).toThrow(expect.objectContaining({ status: 503, code: "maintenance" }));
    expect(lease.refusal()).toContain("p1b");
  });

  it("refuses a competing lease without revealing the token, and replays the holder's own retry unchanged", () => {
    const lease = open();
    const first = lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle);
    clock += 10_000;
    const competing = lease.acquire({ token: OTHER, holder: "other", ttlMs: 60_000 }, idle);
    expect(competing).toMatchObject({ ok: false, status: 409, code: "lease-held", lease: { holder: "p1b" } });
    expect(JSON.stringify(competing)).not.toContain(TOKEN);
    const retry = lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 600_000 }, () => "busy now");
    expect(retry).toMatchObject({ ok: true, status: 200, replayed: true, remainingMs: 50_000 });
    expect(retry.ok && retry.state === "held" && first.ok && first.state === "held" && retry.lease.leaseId === first.lease.leaseId).toBe(true);
    expect(lease.check(OTHER)).toMatchObject({ ok: false, code: "lease-not-held" });
  });

  it("expires on its own, cannot be renewed or reused after, and lets a new holder in", () => {
    const lease = open();
    lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle);
    clock += 30_000;
    expect(lease.renew({ token: TOKEN, ttlMs: 60_000 })).toMatchObject({ ok: true, lease: { expiresAt: clock + 60_000 } });
    clock += 59_999;
    expect(lease.check(TOKEN)).toMatchObject({ ok: true, remainingMs: 1 });
    clock += 1;
    expect(lease.current()).toBeNull();
    expect(() => lease.assertTurns()).not.toThrow();
    expect(lease.check(TOKEN)).toMatchObject({ ok: false, code: "lease-ended", ended: "expired" });
    expect(lease.renew({ token: TOKEN, ttlMs: 60_000 })).toMatchObject({ ok: false, code: "lease-ended", ended: "expired" });
    expect(lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle)).toMatchObject({ ok: false, code: "lease-ended" });
    expect(lease.release(TOKEN)).toMatchObject({ ok: true, state: "expired", replayed: true });
    expect(lease.acquire({ token: OTHER, holder: "next", ttlMs: 60_000 }, idle)).toMatchObject({ ok: true, status: 201 });
  });

  it("releases once, answers a release retry with how it ended, and never re-grants that token", () => {
    const lease = open();
    const granted = lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle);
    const leaseId = granted.ok && granted.state === "held" ? granted.lease.leaseId : "";
    expect(lease.release(OTHER)).toMatchObject({ ok: false, code: "lease-not-held" });
    expect(lease.current()).not.toBeNull();
    expect(lease.release(TOKEN)).toEqual({ ok: true, status: 200, state: "released", leaseId });
    expect(lease.release(TOKEN)).toEqual({ ok: true, status: 200, state: "released", leaseId, replayed: true });
    expect(lease.check(TOKEN)).toMatchObject({ ok: false, code: "lease-ended", ended: "released", leaseId });
    expect(lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle)).toMatchObject({ ok: false, code: "lease-ended" });
  });

  it("survives a server restart with its expiry and stores only the token's hash", () => {
    open().acquire({ token: TOKEN, holder: "p1b", ttlMs: 120_000 }, idle);
    const file = join(dir, MAINTENANCE_LEASE_FILE);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    clock += 60_000;
    const restarted = open();
    expect(() => restarted.assertTurns()).toThrow(expect.objectContaining({ code: "maintenance" }));
    expect(restarted.check(TOKEN)).toMatchObject({ ok: true, remainingMs: 60_000 });
    expect(restarted.release(TOKEN)).toMatchObject({ ok: true, state: "released" });
    const again = open();
    expect(again.current()).toBeNull();
    expect(again.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle)).toMatchObject({ ok: false, code: "lease-ended", ended: "released" });
  });

  it("treats an unreadable state file as held by an unknown controller for the longest lease", () => {
    writeFileSync(join(dir, MAINTENANCE_LEASE_FILE), "{ torn");
    const lease = open();
    expect(lease.current()).toMatchObject({ leaseId: UNREADABLE_LEASE_ID, expiresAt: clock + MAINTENANCE_LEASE_MAX_TTL_MS });
    expect(() => lease.assertTurns()).toThrow(expect.objectContaining({ code: "maintenance" }));
    expect(lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle)).toMatchObject({ ok: false, code: "lease-held" });
    clock += MAINTENANCE_LEASE_MAX_TTL_MS;
    expect(lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle)).toMatchObject({ ok: true, status: 201 });
    expect(open().check(TOKEN)).toMatchObject({ ok: true });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("grants, renews and releases nothing it could not save", () => {
    const lease = open();
    chmodSync(dir, 0o500);
    expect(() => lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle)).toThrow();
    expect(lease.current()).toBeNull();
    chmodSync(dir, 0o700);
    lease.acquire({ token: TOKEN, holder: "p1b", ttlMs: 60_000 }, idle);
    chmodSync(dir, 0o500);
    clock += 10_000;
    expect(() => lease.renew({ token: TOKEN, ttlMs: 60_000 })).toThrow();
    expect(() => lease.release(TOKEN)).toThrow();
    expect(lease.check(TOKEN)).toMatchObject({ ok: true, remainingMs: 50_000 });
  });

  it.each([
    [{ token: "short", holder: "p1b", ttlMs: 60_000 }, /token/],
    [{ token: TOKEN, holder: " ", ttlMs: 60_000 }, /holder/],
    [{ token: TOKEN, holder: "p1b", ttlMs: MAINTENANCE_LEASE_MIN_TTL_MS - 1 }, /ttlMs/],
    [{ token: TOKEN, holder: "p1b", ttlMs: MAINTENANCE_LEASE_MAX_TTL_MS + 1 }, /ttlMs/],
    [{ token: TOKEN, holder: "p1b", ttlMs: 60_000.5 }, /ttlMs/],
  ])("refuses a malformed acquisition %j", (input, error) => {
    const lease = open();
    expect(lease.acquire(input, idle)).toMatchObject({ ok: false, status: 400, code: "invalid", error: expect.stringMatching(error) });
    expect(lease.current()).toBeNull();
  });
});