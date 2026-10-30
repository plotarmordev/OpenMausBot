// One isolated fake-engine server: the install header on WebSocket refusals, on requests Node answers itself, and on
// an unexpected fault's 500.
import { rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const descriptor = z.object({ environmentId: z.uuid() });
const fleet = z.object({ bots: z.array(z.object({ threadId: z.string() })).min(1) });

type Answer = { status: number; environment: string | null };

let fixture: VerificationServer;
let install: string;

const api = async (path: string) => {
  const response = await fetch(`${fixture.info.url}${path}`, { headers: { origin: fixture.info.url } });
  return { status: response.status, environment: response.headers.get("openmausbot-environment"), body: await response.json() as unknown };
};

const upgrade = (path: string) => new Promise<Answer>((resolve, reject) => {
  const answered = (status: number, environment: string | string[] | undefined) =>
    resolve({ status, environment: typeof environment === "string" ? environment : null });
  const req = request(new URL(path, fixture.info.url), { headers: {
    connection: "Upgrade", upgrade: "websocket", origin: fixture.info.url,
    "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  } });
  req.once("response", (res) => { res.resume(); answered(res.statusCode!, res.headers["openmausbot-environment"]); });
  req.once("upgrade", (res, socket) => { socket.destroy(); answered(res.statusCode!, res.headers["openmausbot-environment"]); });
  req.once("error", reject);
  req.end();
});

beforeAll(async () => {
  fixture = await launchVerificationServer({ ...process.env, OMB_TEST_ROUTE_FAULT: "1" });
  install = descriptor.parse((await api("/.well-known/openmausbot/environment")).body).environmentId;
}, 60_000);
afterAll(() => fixture?.close());

it("names the install on WebSocket upgrades that no route owns, and only under its prefixes", async () => {
  expect(await upgrade("/api/no-such-route")).toEqual({ status: 404, environment: install });
  expect(await upgrade("/.well-known/openmausbot/no-such-route")).toEqual({ status: 404, environment: install });
  expect(await upgrade("/no-such-route")).toEqual({ status: 404, environment: null });
  const refusedByRoute = await upgrade("/api/bots/no-such-bot/browser/stream");
  expect(refusedByRoute.status).toBeGreaterThanOrEqual(400);
  expect(refusedByRoute.environment).toBe(install);
});

/** The heads of every answer to one raw request, interim ones first, read until the server closes. */
const raw = (lines: string[]) => new Promise<string[][]>((resolve, reject) => {
  const url = new URL(fixture.info.url);
  const socket = connect(Number(url.port), "127.0.0.1");
  let text = "";
  socket.on("data", (chunk) => { text += chunk; });
  socket.once("end", () => resolve(text.split(/\r\n\r\n/).filter((part) => part.startsWith("HTTP/1.1 ")).map((part) => part.split("\r\n"))));
  socket.once("error", reject);
  socket.write(`${[...lines, "connection: close"].join("\r\n")}\r\n\r\n`);
});
const statusAndInstall = (head: string[]) =>
  [head[0], head.find((line) => /^openmausbot-environment: /i.test(line))?.slice("openmausbot-environment: ".length) ?? null];

it("names the install on the answers Node gives itself to a missing Host and an unsupported Expect", async () => {
  const host = `host: ${new URL(fixture.info.url).host}`, origin = `origin: ${fixture.info.url}`;
  for (const path of ["/api/bots", "/.well-known/openmausbot/environment"]) {
    expect((await raw([`GET ${path} HTTP/1.1`, host, origin, "expect: unsupported"])).map(statusAndInstall))
      .toEqual([["HTTP/1.1 417 Expectation Failed", install]]);
    expect((await raw([`GET ${path} HTTP/1.1`, origin])).map(statusAndInstall)).toEqual([["HTTP/1.1 400 Bad Request", install]]);
    // Host is checked first, as Node does.
    expect((await raw([`GET ${path} HTTP/1.1`, origin, "expect: unsupported"])).map(statusAndInstall)).toEqual([["HTTP/1.1 400 Bad Request", install]]);
    expect((await raw([`GET ${path} HTTP/1.1`, origin, "expect: 100-continue"])).map(statusAndInstall)).toEqual([["HTTP/1.1 400 Bad Request", install]]);
  }
  expect((await raw(["GET /outside HTTP/1.1", host, "expect: unsupported"])).map(statusAndInstall)).toEqual([["HTTP/1.1 417 Expectation Failed", null]]);
  expect((await raw(["GET /outside HTTP/1.1"])).map(statusAndInstall)).toEqual([["HTTP/1.1 400 Bad Request", null]]);
  // 100-continue is unchanged: the interim answer, then the route's own, which authentication still decides.
  expect((await raw(["GET /api/bots HTTP/1.1", host, origin, "expect: 100-continue"])).map(statusAndInstall))
    .toEqual([["HTTP/1.1 100 Continue", null], ["HTTP/1.1 200 OK", install]]);
  expect((await raw(["GET /api/bots HTTP/1.1", host, "origin: https://untrusted.example.test", "x-forwarded-for: 203.0.113.5", "expect: 100-continue"])).map(statusAndInstall))
    .toEqual([["HTTP/1.1 100 Continue", null], ["HTTP/1.1 403 Forbidden", install]]);
  // HTTP/1.0 has neither check.
  expect((await raw(["GET /api/bots HTTP/1.0", origin, "expect: unsupported"])).map(statusAndInstall).at(-1)?.[1]).toBe(install);
});

it("names the install on the 500 the dispatcher's catch answers for a fault with no status", async () => {
  const threadId = fleet.parse((await api("/api/bots")).body).bots[0].threadId;
  const marker = join(fixture.info.dataDir, "fail-thread-read");
  writeFileSync(marker, "");
  try {
    expect(await api(`/api/threads/${threadId}/messages?limit=1`)).toMatchObject({
      status: 500, environment: install, body: { error: "test fault: reading this thread failed" },
    });
  } finally {
    rmSync(marker);
  }
  expect(await api(`/api/threads/${threadId}/messages?limit=1`)).toMatchObject({ status: 200, environment: install });
});
