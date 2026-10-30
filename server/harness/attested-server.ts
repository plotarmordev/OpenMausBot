import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Attestation } from "../environment.ts";

/** The path a request names, or undefined when its target does not parse as a URL. */
export function requestPath(url: string): string | undefined {
  try { return new URL(url, "http://localhost").pathname; }
  catch { return undefined; }
}

/** Node 24 refuses an HTTP/1.1 request without a Host header (RFC 9112 3.2) before it reads Expect. */
function refusedForHost(req: IncomingMessage, res: ServerResponse, attest: (path: string) => Attestation): boolean {
  if (req.httpVersion !== "1.1" || req.headers.host !== undefined) return false;
  answer(req, res, attest, 400, { Connection: "close" });
  return true;
}

function answer(req: IncomingMessage, res: ServerResponse, attest: (path: string) => Attestation, status: number, headers: Record<string, string> = {}): void {
  const url = req.url ?? "";
  for (const [name, value] of attest(requestPath(url) ?? url)) res.setHeader(name, value);
  res.writeHead(status, headers).end();
}

/** An HTTP server whose own answers to requests it parsed carry the attestation, as `handle`'s do.
 *
 * Node 24's server answers two parsed HTTP/1.1 requests itself, before any request listener runs: one without a Host
 * header (400, closing the connection) and one whose Expect is not 100-continue (417). The same answers are given
 * here, attested. The interim `100 Continue` takes no headers and stays as Node writes it; the final answer that
 * follows it is `handle`'s. */
export function createAttestedServer(
  handle: (req: IncomingMessage, res: ServerResponse) => unknown,
  attest: (path: string) => Attestation,
): Server {
  const server = createServer({ requireHostHeader: false }, (req, res) => {
    if (!refusedForHost(req, res, attest)) void handle(req, res);
  });
  server.on("checkExpectation", (req: IncomingMessage, res: ServerResponse) => {
    if (!refusedForHost(req, res, attest)) answer(req, res, attest, 417);
  });
  // Node's own continue handling, after the Host check it would have made first.
  server.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => {
    if (refusedForHost(req, res, attest)) return;
    res.writeContinue();
    server.emit("request", req, res);
  });
  return server;
}
