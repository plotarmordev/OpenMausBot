// One isolated fake-engine server: the install header on WebSocket refusals and on an unexpected fault's 500.
import { rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
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
