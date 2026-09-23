/**
 * The daemon's listener (spec section 3.1 step 1): one HTTP request handler
 * served on a Unix socket (for `tacho-hook`) and on `127.0.0.1:<port>` (for
 * Claude Code's `http` hooks and its OTLP exporter). Every request carries
 * the per-install bearer so another local user cannot post fake events.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import type { TachoHarness } from "../wire";
import type { ExportFormat } from "./exporters";
import type { HookReplay } from "./hook-handler";
import { GUARD_MESSAGES, guardLoopbackRequest } from "./loopback-guard";
import type {
  IssueRunTokenAnswer,
  IssueRunTokenRequest,
} from "./credential-issuer";
import type { GatewayHttpResponse } from "./mcp-gateway";

export interface HookEnvelope {
  payload: unknown;
  env?: Record<string, string | undefined>;
  replay?: HookReplay;
  /** Which harness ran the hook; absent means Claude Code. */
  harness?: TachoHarness;
  /** A custom agent's name (`tacho hook --agent`); wins over `harness`. */
  agent?: string;
  /**
   * The id `tacho-hook` gave this hook when it read stdin. The live request
   * and a spool replay of the same hook carry the same id, so a hook the
   * daemon answered after the client gave up is recorded once.
   */
  hook_id?: string;
}

/** What the daemon exposes to the listener; the daemon implements it. */
export interface CollectorApi {
  localToken: string;
  enrollmentId: string;
  handleHook: (envelope: HookEnvelope) => Promise<Record<string, unknown>>;
  handleOtlp: (
    signal: "logs" | "metrics" | "traces",
    payload: unknown,
  ) => Promise<void>;
  health: () => Record<string, unknown>;
  status: () => Record<string, unknown>;
  sessions: () => Array<Record<string, unknown>>;
  exportSession: (key: string, format: ExportFormat) => string | undefined;
  /**
   * The local MCP gateway (ADR-078). Absent on a daemon built without one,
   * in which case `/mcp` is a 404 like any other unknown route.
   */
  mcp?: (
    body: unknown,
    context: { sessionId: string; enrollmentId?: string },
  ) => Promise<GatewayHttpResponse>;
  /** Drop a gateway session's state when its connection closes. */
  mcpClose?: (sessionId: string) => void;
  /**
   * Mint a run token for a brokered harness (ADR-143). `tacho credential
   * issue` calls this over the socket with the local bearer; Claude Code
   * runs that command as its `apiKeyHelper`. Absent on a daemon built
   * without the credential seam, in which case `/credential/issue` is a 404.
   */
  issueRunToken?: (input: IssueRunTokenRequest) => IssueRunTokenAnswer;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  // `undefined` is a real answer, not a missing one. An MCP notification
  // (`notifications/initialized`, which every client sends straight after the
  // handshake) is acknowledged upstream with 202 and an empty body, which
  // `readRpcBody` reports as `undefined` — and `JSON.stringify(undefined)` is
  // `undefined`, not a string, so `Buffer.byteLength` threw and the outer catch
  // turned a successful acknowledgement into a 500. A body-less response gets a
  // body-less reply, with no Content-Type to describe a body that is not there.
  if (body === undefined) {
    res.writeHead(status, { "Content-Length": 0, ...headers });
    res.end();
    return;
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string"
        ? "text/plain; charset=utf-8"
        : "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  if (presented.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

export interface RequestHandlerOptions {
  /**
   * The loopback port this handler answers on. Set for the TCP listener,
   * which is reachable by anything on the machine including a page in the
   * user's browser, and therefore gets the DNS-rebinding guard. Left unset
   * for the Unix socket: it is mode 0600 and no browser can address it, so
   * there is nothing for the guard to refuse and the `Host` header Node
   * synthesises for a socket request would fail it.
   */
  guardPort?: number;
}

export function createRequestHandler(
  api: CollectorApi,
  log: (line: string) => void,
  options: RequestHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://tachod.local");
      if (options.guardPort !== undefined) {
        const verdict = guardLoopbackRequest(
          {
            host: req.headers.host,
            origin: req.headers.origin as string | undefined,
          },
          options.guardPort,
        );
        if (!verdict.ok) {
          const reason = verdict.reason ?? "host";
          log(
            `refused ${req.method ?? "?"} ${url.pathname}: ${reason} header (host=${String(req.headers.host)}, origin=${String(req.headers.origin)})`,
          );
          send(res, 403, { error: GUARD_MESSAGES[reason] });
          return;
        }
      }
      if (!authorized(req, api.localToken)) {
        send(res, 401, { error: "local bearer required" });
        return;
      }
      const path = url.pathname;
      try {
        if (req.method === "GET" && path === "/health") {
          send(res, 200, api.health());
          return;
        }
        if (req.method === "GET" && path === "/status") {
          send(res, 200, api.status());
          return;
        }
        if (req.method === "GET" && path === "/sessions") {
          send(res, 200, { sessions: api.sessions() });
          return;
        }
        const exportMatch = /^\/sessions\/([^/]+)\/export$/.exec(path);
        if (req.method === "GET" && exportMatch !== null) {
          const format = (url.searchParams.get("format") ??
            "tacho") as ExportFormat;
          const text = api.exportSession(
            decodeURIComponent(exportMatch[1] as string),
            format,
          );
          if (text === undefined) send(res, 404, { error: "unknown session" });
          else send(res, 200, text);
          return;
        }
        if (req.method === "DELETE" && /^\/mcp(?:\/[^/]+)?$/.test(path)) {
          const presented = req.headers["mcp-session-id"];
          if (typeof presented === "string" && presented.length > 0)
            api.mcpClose?.(presented);
          send(res, 204, "");
          return;
        }
        if (req.method !== "POST") {
          send(res, 405, { error: "method not allowed" });
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = raw.length === 0 ? {} : JSON.parse(raw);
        } catch {
          send(res, 400, { error: "invalid JSON" });
          return;
        }
        if (path === "/credential/issue") {
          if (api.issueRunToken === undefined) {
            send(res, 404, { error: "this daemon issues no run tokens" });
            return;
          }
          const answer = api.issueRunToken(
            (typeof parsed === "object" && parsed !== null
              ? parsed
              : {}) as IssueRunTokenRequest,
          );
          send(res, answer.status, answer.body);
          return;
        }
        if (path === "/hook" || path === `/hook/${api.enrollmentId}`) {
          const isEnvelope = req.headers["x-tacho-envelope"] === "1";
          const envelope: HookEnvelope = isEnvelope
            ? (parsed as HookEnvelope)
            : { payload: parsed };
          send(res, 200, await api.handleHook(envelope));
          return;
        }
        if (path.startsWith("/hook/")) {
          send(res, 403, { error: "hook for another enrollment" });
          return;
        }
        const mcpMatch = /^\/mcp(?:\/([^/]+))?$/.exec(path);
        if (mcpMatch !== null) {
          if (api.mcp === undefined) {
            send(res, 404, { error: "no local MCP gateway on this daemon" });
            return;
          }
          // A streamable-HTTP client is given a session id on `initialize`
          // and echoes it from then on. The id scopes the evidence chain, so
          // it is minted here rather than taken from the client: a client
          // that chose its own could write into another app's chain.
          const presented = req.headers["mcp-session-id"];
          const sessionId =
            typeof presented === "string" && presented.length > 0
              ? presented
              : `mcp_${randomBytes(12).toString("hex")}`;
          const scoped = mcpMatch[1];
          const answer = await api.mcp(parsed, {
            sessionId,
            ...(scoped === undefined ? {} : { enrollmentId: scoped }),
          });
          send(res, answer.status, answer.body, {
            "Mcp-Session-Id": sessionId,
          });
          return;
        }
        const otlp = /^\/v1\/(logs|metrics|traces)$/.exec(path);
        if (otlp !== null) {
          await api.handleOtlp(
            otlp[1] as "logs" | "metrics" | "traces",
            parsed,
          );
          send(res, 200, { partialSuccess: {} });
          return;
        }
        send(res, 404, { error: "not found" });
      } catch (error) {
        log(
          `request ${req.method ?? "?"} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        send(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };
}

export interface ListenOptions {
  socketPath?: string;
  port?: number;
  host?: string;
}

export interface CollectorServer {
  listen: (options: ListenOptions) => Promise<{ port: number | undefined }>;
  close: () => Promise<void>;
}

/** Only a refused connection establishes that an existing Unix socket is stale. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (!statSync(socketPath).isSocket()) {
    throw new Error(`collector socket path is not a socket: ${socketPath}`);
  }
  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
        resolve(true);
      else reject(error);
    });
    probe.setTimeout(500, () => {
      probe.destroy();
      resolve(false);
    });
  });
  if (!stale)
    throw new Error(`another collector is listening on ${socketPath}`);
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createCollectorServer(
  api: CollectorApi | (() => CollectorApi | undefined),
  log: (line: string) => void = () => undefined,
): CollectorServer {
  const handle = (
    req: IncomingMessage,
    res: ServerResponse,
    guardPort?: number,
  ) => {
    const ready = typeof api === "function" ? api() : api;
    if (ready === undefined) {
      send(res, 503, { error: "collector is starting" });
      return;
    }
    createRequestHandler(
      ready,
      log,
      guardPort === undefined ? {} : { guardPort },
    )(req, res);
  };
  const servers: Server[] = [];
  const close = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
          }),
      ),
    );
    servers.length = 0;
  };
  return {
    listen: async (options) => {
      let port: number | undefined;
      try {
        // Claim the host's port before touching its Unix socket. A competing
        // daemon must not replace the hook listener and then fail its TCP bind.
        if (options.port !== undefined) {
          let boundPort = options.port;
          const tcp = createServer((req, res) => handle(req, res, boundPort));
          servers.push(tcp);
          await new Promise<void>((resolve, reject) => {
            tcp.once("error", reject);
            tcp.listen(options.port, options.host ?? "127.0.0.1", () => {
              tcp.off("error", reject);
              resolve();
            });
          });
          const address = tcp.address();
          port =
            typeof address === "object" && address !== null
              ? address.port
              : options.port;
          boundPort = port;
        }
        if (options.socketPath !== undefined) {
          await removeStaleSocket(options.socketPath);
          const unix = createServer((req, res) => handle(req, res));
          servers.push(unix);
          await new Promise<void>((resolve, reject) => {
            unix.once("error", reject);
            unix.listen(options.socketPath, () => {
              unix.off("error", reject);
              resolve();
            });
          });
          chmodSync(options.socketPath, 0o600);
        }
        return { port };
      } catch (error) {
        // A partial bind must not leave an orphan hook listener alive after
        // the CLI reports a failed startup.
        await close();
        throw error;
      }
    },
    close,
  };
}
