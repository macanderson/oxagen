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
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import type { ExportFormat } from "./exporters";
import type { HookReplay } from "./hook-handler";

export interface HookEnvelope {
  payload: unknown;
  env?: Record<string, string | undefined>;
  replay?: HookReplay;
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string"
        ? "text/plain; charset=utf-8"
        : "application/json",
    "Content-Length": Buffer.byteLength(text),
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

export function createRequestHandler(
  api: CollectorApi,
  log: (line: string) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://tachod.local");
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

export function createCollectorServer(
  api: CollectorApi,
  log: (line: string) => void = () => undefined,
): CollectorServer {
  const handler = createRequestHandler(api, log);
  const servers: Server[] = [];
  return {
    listen: async (options) => {
      let port: number | undefined;
      if (options.socketPath !== undefined) {
        if (existsSync(options.socketPath)) unlinkSync(options.socketPath);
        const unix = createServer(handler);
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
      if (options.port !== undefined) {
        const tcp = createServer(handler);
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
      }
      return { port };
    },
    close: async () => {
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
    },
  };
}
