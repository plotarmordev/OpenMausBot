// Real harness and fake engine in a throwaway home; no live OpenMausBot data is touched.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { withoutTurnClock } from "./testing/turn-clock-text.ts";

const TOKEN = "p1b-controller-token-0123456789abcdefghijk";
const botsBody = z.object({ bots: z.array(z.object({ id: z.string(), busy: z.boolean().optional() })) });
const linesBody = z.object({ messages: z.array(z.object({ text: z.string().optional() })) });
const createdBot = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) });
const createdGroup = z.object({ group: z.object({ id: z.string(), threadId: z.string() }) });
const leaseBody = z.object({ lease: z.object({ leaseId: z.string() }) });
const soulBody = z.object({ soul: z.string(), soulRevision: z.string() });
const writeBody = z.object({ revision: z.string() });

describe.skipIf(process.platform === "win32")("deployment controller primitives", () => {
  let session: VerificationServer;
  let fixture: string;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: session.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as unknown, text };
  };
  const busy = async (id: string) => botsBody.parse((await api("GET", "/api/bots")).body).bots.find((item) => item.id === id)?.busy === true;
  const replied = async (path: string, text: string) => linesBody.parse((await api("GET", path)).body).messages
    .some((line) => withoutTurnClock(line.text ?? "").startsWith(`reply to: ${text}`));
  const soul = async (botId: string) => soulBody.parse((await api("GET", `/api/bots/${botId}/soul`)).body);

  beforeEach(async () => {
    fixture = mkdtempSync(join(tmpdir(), "omb-lease-api-"));
    session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(fixture, "finish.gate") });
  }, 30_000);

  afterEach(async () => {
    if (session) await session.close();
    if (fixture) await removeTempDir(fixture);
  });

  it("is granted only at a quiet moment, refuses every new turn while held, and fences soul writes", async () => {
    const created = await api("POST", "/api/bots", { name: "Lease bot", soul: "OLD", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(created.status).toBe(201);
    const { id: botId, threadId } = createdBot.parse(created.body).bot;
    const room = createdGroup.parse((await api("POST", "/api/groups", { name: "Lease room", memberIds: [botId],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId } } })).body).group;

    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "HOLD", threadId })).status).toBe(202);
    await expect.poll(() => busy(botId), { timeout: 10_000 }).toBe(true);
    expect(await api("POST", "/api/maintenance/lease", { token: TOKEN, holder: "p1b apply", ttlMs: 60_000 }))
      .toMatchObject({ status: 409, body: { code: "busy", busy: "Lease bot" } });
    writeFileSync(join(fixture, "finish.gate"), "ready");
    await expect.poll(() => busy(botId), { timeout: 10_000 }).toBe(false);

    const granted = await api("POST", "/api/maintenance/lease", { token: TOKEN, holder: "p1b apply", ttlMs: 60_000 });
    expect(granted).toMatchObject({ status: 201, body: { state: "held", lease: { holder: "p1b apply" } } });
    const { lease } = leaseBody.parse(granted.body);
    expect(await api("POST", "/api/maintenance/lease", { token: TOKEN.replace("p1b", "xyz"), holder: "other", ttlMs: 60_000 }))
      .toMatchObject({ status: 409, body: { code: "lease-held", lease: { leaseId: lease.leaseId } } });
    const status = await api("GET", "/api/maintenance/lease");
    expect(status.body).toMatchObject({ held: true, lease });
    expect(status.text).not.toContain(TOKEN);

    const refused = await api("POST", `/api/bots/${botId}/messages`, { text: "DURING", threadId });
    expect(refused.status).toBe(503);
    expect(refused.text).toContain("paused for maintenance");
    const roomRefused = await api("POST", `/api/groups/${room.id}/messages`, { text: "ROOM DURING" });
    expect(roomRefused).toMatchObject({ status: 503, text: expect.stringContaining("paused for maintenance") });
    expect((await api("GET", `/api/threads/${room.threadId}/messages`)).text).not.toContain("ROOM DURING");
    expect(await busy(botId)).toBe(false);
    expect(await replied(`/api/threads/${threadId}/messages`, "DURING")).toBe(false);

    const read = (await soul(botId)).soulRevision;
    const write = (text: string, expectedRevision: string, requestId: string, leaseToken?: string) =>
      api("POST", `/api/bots/${botId}/soul/compare-and-set`, { soul: text, expectedRevision, requestId, ...(leaseToken ? { leaseToken } : {}) });
    expect(await write("M", read, "apply-0001", TOKEN.replace("p1b", "abc"))).toMatchObject({ status: 409, body: { code: "lease-not-held" } });
    const applied = await write("M", read, "apply-0001", TOKEN);
    expect(applied).toMatchObject({ status: 200, body: { state: "applied", previousRevision: read } });
    const { revision } = writeBody.parse(applied.body);
    expect(await write("M", read, "apply-0001", TOKEN)).toMatchObject({ status: 200, body: { replayed: true, revision } });
    expect(await api("GET", `/api/bots/${botId}/soul/writes/apply-0001`))
      .toMatchObject({ status: 200, body: { state: "applied", revision, currentRevision: revision } });

    expect((await api("PATCH", `/api/bots/${botId}`, { soul: "M" })).status).toBe(200);
    const foreign = (await soul(botId)).soulRevision;
    expect(foreign).not.toBe(revision);
    expect(await write("OLD", revision, "rollback-0001", TOKEN))
      .toMatchObject({ status: 409, body: { code: "revision-mismatch", currentRevision: foreign } });
    expect(await api("POST", `/api/bots/${botId}/soul/writes/apply-0002/void`)).toMatchObject({ status: 200, body: { state: "voided" } });
    expect(await write("X", foreign, "apply-0002", TOKEN)).toMatchObject({ status: 409, body: { code: "request-voided" } });
    expect((await soul(botId)).soul).toBe("M");

    expect(await api("POST", "/api/maintenance/lease/release", { token: TOKEN })).toMatchObject({ status: 200, body: { state: "released" } });
    expect(await api("POST", "/api/maintenance/lease/release", { token: TOKEN })).toMatchObject({ status: 200, body: { state: "released", replayed: true } });
    expect(await write("Y", foreign, "apply-0003", TOKEN)).toMatchObject({ status: 409, body: { code: "lease-ended", ended: "released" } });
    expect(await write("M", read, "apply-0001", TOKEN)).toMatchObject({ status: 200, body: { replayed: true, revision } });
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "AFTER", threadId })).status).toBe(202);
    await expect.poll(() => replied(`/api/threads/${threadId}/messages`, "AFTER"), { timeout: 10_000 }).toBe(true);
  }, 60_000);

  it.each(["release", "expiry"])("keeps restored direct and room queues pending until lease %s", async (ending) => {
    writeFileSync(join(fixture, "finish.gate"), "ready");
    const bot = createdBot.parse((await api("POST", "/api/bots", { name: "Queued direct" })).body).bot;
    const member = createdBot.parse((await api("POST", "/api/bots", { name: "Queued room member" })).body).bot;
    const room = createdGroup.parse((await api("POST", "/api/groups", { name: "Queued room", memberIds: [member.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: member.id } } })).body).group;
    expect((await api("POST", "/api/maintenance/lease", { token: TOKEN, holder: "restart fixture", ttlMs: ending === "expiry" ? 15_000 : 60_000 })).status).toBe(201);
    await waitForExit(session.child, { signal: "SIGTERM" });
    const { dataDir, logPath, url } = session.info;
    const db = new DatabaseSync(join(dataDir, "messages.db"));
    try {
      const insert = db.prepare("INSERT INTO chat_followups(id, kind, owner_id, thread_id, send_id, status, payload) VALUES (?, ?, ?, ?, NULL, 'pending', ?)");
      insert.run("lease-direct", "bot", bot.id, bot.threadId, JSON.stringify({ text: "DIRECT AFTER LEASE" }));
      insert.run("lease-room", "channel", room.id, room.threadId, JSON.stringify({ text: "ROOM AFTER LEASE", mode: "chat" }));
    } finally { db.close(); }
    const pending = () => {
      const persisted = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
      try { return persisted.prepare("SELECT id, status FROM chat_followups ORDER BY id").all(); }
      finally { persisted.close(); }
    };
    let restarted: ChildProcess | undefined;
    try {
      const log = openSync(logPath, "a", 0o600);
      try {
        restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: verificationServerEnvironment({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(fixture, "finish.gate") }, dataDir, Number(new URL(url).port)),
          stdio: ["ignore", log, log],
        });
      } finally { closeSync(log); }
      await expect.poll(async () => {
        expect(restarted?.exitCode, logPath).toBeNull();
        try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; }
        catch { return false; }
      }, { timeout: 10_000 }).toBe(true);
      expect((await api("POST", "/api/maintenance/lease/check", { token: TOKEN })).body).toMatchObject({ state: "held" });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "BLOCKED", threadId: bot.threadId })).status).toBe(503);
      expect(pending()).toEqual([{ id: "lease-direct", status: "pending" }, { id: "lease-room", status: "pending" }]);
      if (ending === "release") expect((await api("POST", "/api/maintenance/lease/release", { token: TOKEN })).status).toBe(200);
      await expect.poll(() => replied(`/api/threads/${bot.threadId}/messages`, "DIRECT AFTER LEASE"), { timeout: 25_000 }).toBe(true);
      await expect.poll(() => replied(`/api/threads/${room.threadId}/messages`, "ROOM AFTER LEASE"), { timeout: 10_000 }).toBe(true);
      await expect.poll(pending, { timeout: 5_000 }).toEqual([]);
    } finally {
      if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    }
  }, 60_000);

  it("never lets a racing turn and a lease both win, nor two writers of one soul revision", async () => {
    writeFileSync(join(fixture, "finish.gate"), "ready");
    const { id: botId, threadId } = createdBot.parse((await api("POST", "/api/bots", { name: "Race bot",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body).bot;
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const token = `${TOKEN}-${round}`;
      const [sent, leased] = await Promise.all([
        api("POST", `/api/bots/${botId}/messages`, { text: `RACE ${round}`, threadId }),
        api("POST", "/api/maintenance/lease", { token, holder: "racer", ttlMs: 60_000 }),
      ]);
      outcomes.add(`${sent.status}/${leased.status}`);
      if (leased.status === 201) {
        expect(sent).toMatchObject({ status: 503, text: expect.stringContaining("paused for maintenance") });
        expect(await busy(botId)).toBe(false);
        expect((await api("POST", "/api/maintenance/lease/release", { token })).status).toBe(200);
      } else {
        expect(sent.status).toBe(202);
        expect(leased).toMatchObject({ status: 409, body: { code: "busy" } });
        await expect.poll(() => replied(`/api/threads/${threadId}/messages`, `RACE ${round}`), { timeout: 10_000 }).toBe(true);
        await expect.poll(() => busy(botId), { timeout: 10_000 }).toBe(false);
      }
    }
    expect([...outcomes].every((outcome) => outcome === "503/201" || outcome === "202/409")).toBe(true);

    const read = (await soul(botId)).soulRevision;
    const writers = await Promise.all(["A", "B", "C"].map((text, index) =>
      api("POST", `/api/bots/${botId}/soul/compare-and-set`, { soul: text, expectedRevision: read, requestId: `racer-000${index}` })));
    expect(writers.filter((writer) => writer.status === 200)).toHaveLength(1);
    expect(writers.filter((writer) => writer.status === 409).map((writer) => writer.body)).toEqual([
      expect.objectContaining({ code: "revision-mismatch" }), expect.objectContaining({ code: "revision-mismatch" }),
    ]);
  }, 60_000);
});