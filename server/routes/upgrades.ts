// WebSocket upgrades go through the same request handler as HTTP, so they pass the same authentication,
// hosted-workspace and maintenance gates; the route that owns the path then answers the handshake.
import { ServerResponse, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type ServerOptions, type WebSocket } from "ws";
import type { Attestation } from "../environment.ts";
import { requestPath } from "../harness/attested-server.ts";

const HANDSHAKE_MS = 10_000;
const EARLY_BYTES = 64 * 1024;

export interface PendingUpgrade {
  readonly socket: Socket;
  /** Bytes the client sent before its handshake was answered. */
  head: Buffer;
  /** Headers every answer written straight to the socket carries, as the request handler's own answers do. */
  readonly attestation: Attestation;
  /** The route answers the handshake now: from here on it reads the socket itself. */
  release(): void;
}

export interface Upgrades {
  /** Upgrades to a path `owns` accepts reach the request handler; any other is answered 404. */
  route(owns: (path: string) => boolean): void;
  attach(server: Server, handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>): void;
  pending(req: IncomingMessage): PendingUpgrade | undefined;
  /** Refuses new upgrades and drops every one not answered yet. */
  close(): void;
}

function headerLines(attestation: Attestation): string[] {
  return attestation.map(([name, value]) => `${name}: ${value}`);
}

export function createUpgrades(attest: (path: string) => Attestation = () => []): Upgrades {
  const owners: Array<(path: string) => boolean> = [];
  const pending = new Map<IncomingMessage, PendingUpgrade>();
  let stopped = false;

  return {
    route(owns) {
      owners.push(owns);
    },
    attach(server, handle) {
      server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
        if (stopped || !(socket instanceof Socket)) { socket.destroy(); return; }
        const res = new ServerResponse(req);
        res.assignSocket(socket);
        // Rejected upgrades end this socket; do not let HTTP clients pool it.
        res.setHeader("connection", "close");
        socket.on("error", () => socket.destroy());
        res.once("finish", () => socket.end(() => socket.destroy()));
        const path = requestPath(req.url ?? "");
        const attestation = attest(path ?? req.url ?? "");
        for (const [name, value] of attestation) res.setHeader(name, value);
        if (path === undefined) { res.writeHead(400).end(); return; }
        if (!owners.some((owns) => owns(path))) { res.writeHead(404).end(); return; }
        // Keep reading while auth awaits, so a closed tab's FIN is observed; buffer any eagerly sent WebSocket bytes.
        const upgrade: PendingUpgrade = { socket, head, attestation, release: () => socket.off("data", buffer) };
        const buffer = (data: Buffer) => {
          if (upgrade.head.length + data.length > EARLY_BYTES) socket.destroy();
          else upgrade.head = Buffer.concat([upgrade.head, data]);
        };
        socket.on("data", buffer);
        socket.once("end", () => socket.destroy());
        socket.once("close", () => { upgrade.release(); pending.delete(req); });
        pending.set(req, upgrade);
        const timeout = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
        timeout.unref();
        socket.once("close", () => clearTimeout(timeout));
        void handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
          else socket.destroy();
        }).finally(() => clearTimeout(timeout));
      });
    },
    pending(req) {
      return pending.get(req);
    },
    close() {
      stopped = true;
      for (const upgrade of pending.values()) upgrade.socket.destroy();
    },
  };
}

/** What a WebSocket server needs to answer one handshake the gate admitted. */
export interface Handshake {
  readonly req: IncomingMessage;
  readonly socket: Socket;
  readonly head: Buffer;
  readonly attestation: Attestation;
}

/** Answers admitted handshakes with `ws`: its 101 and each refusal carry the handshake's attestation. */
export function createHandshakes(options: Pick<ServerOptions, "perMessageDeflate" | "maxPayload">): (handshake: Handshake, opened: (ws: WebSocket) => void) => void {
  const server = new WebSocketServer({ ...options, noServer: true });
  const attested = new WeakMap<IncomingMessage, Attestation>();
  server.on("headers", (lines, req) => { lines.push(...headerLines(attested.get(req) ?? [])); });
  // ws 8.22 writes a malformed handshake's refusal itself unless a wsClientError listener answers it, and hands that
  // listener only the error: the refusal ws would write follows from the request method and the message.
  server.on("wsClientError", (error, socket, req) => refuse(socket, req.method === "GET" ? 400 : 405, error.message, attested.get(req) ?? []));
  return (handshake, opened) => {
    attested.set(handshake.req, handshake.attestation);
    server.handleUpgrade(handshake.req, handshake.socket, handshake.head, opened);
  };
}

/** The 101 line and headers of an accepted WebSocket handshake, attested, ready to write to the socket. */
export function switchingProtocols(accept: string, attestation: Attestation): string {
  return [
    "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`,
    ...headerLines(attestation),
  ].join("\r\n") + "\r\n\r\n";
}

const WS_VERSION_REFUSAL = "Missing or invalid Sec-WebSocket-Version header";

/** ws 8.22's own refusal (`abortHandshake`), byte for byte, with the attestation after its headers. */
function refuse(socket: Duplex, status: number, message: string, attestation: Attestation): void {
  const head = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}`, "Connection: close", "Content-Type: text/html",
    `Content-Length: ${Buffer.byteLength(message)}`,
    ...(message === WS_VERSION_REFUSAL ? ["Sec-WebSocket-Version: 13, 8"] : []), ...headerLines(attestation),
  ];
  socket.once("finish", () => socket.destroy());
  socket.end(`${head.join("\r\n")}\r\n\r\n${message}`);
}
