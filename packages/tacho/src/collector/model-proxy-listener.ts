/**
 * The model proxy's own listener, owned by the daemon.
 *
 * It is a sibling of the collector's listener rather than a route on it, for
 * two reasons. The collector requires the per-install bearer in
 * `Authorization` on every request, and a model call already carries the
 * vendor's credential there. And the collector serves OTLP on `/v1/logs`,
 * `/v1/metrics` and `/v1/traces`, which is the namespace both vendors use.
 *
 * It binds `127.0.0.1` and nothing else. It asks for no bearer: a caller
 * brings its own vendor credential, which the proxy only passes on, so a local
 * process gains nothing here it could not get by calling the vendor directly.
 * What it must not be is reachable from a browser page, and the loopback
 * guard's `Host` and `Origin` checks run on every request for that.
 *
 * The listener is now in the agent's critical path, so it does not get to die
 * quietly. A malformed request is answered 400 and the socket closed. If the
 * bind fails or the port is taken, it is rebuilt on a backoff and the
 * daemon's status says `listening: false` until it is back. An error once it
 * is bound is logged and nothing more: it comes from accepting one connection
 * (`EMFILE` when the host is out of descriptors), the listening socket is
 * still open, and tearing it down would cut every stream in flight. If the
 * daemon itself is down the harness gets a refused connection, which is loud on
 * purpose: a base URL that silently fell through to the vendor would be a
 * gateway that can be bypassed by killing it.
 */
import { createServer, type Server } from "node:http";
import type { ModelProxy } from "./model-proxy";

export interface ModelProxyListenerOptions {
  proxy: ModelProxy;
  port: number;
  log: (line: string) => void;
  /** Milliseconds before the first rebind attempt; doubles to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

export interface ModelProxyListener {
  /** Bind. Resolves once the first attempt has settled, bound or not. */
  start: () => Promise<void>;
  listening: () => boolean;
  /** The bound port; the requested one until a bind succeeds. */
  port: () => number;
  restarts: () => number;
  close: () => Promise<void>;
}

const MAX_CONNECTIONS = 512;
/** At most one line per this long for errors on a bound listener. */
const ACCEPT_ERROR_LOG_MS = 10_000;

export function createModelProxyListener(
  options: ModelProxyListenerOptions,
): ModelProxyListener {
  const baseRetryMs = options.retryMs ?? 1_000;
  const maxRetryMs = options.maxRetryMs ?? 30_000;
  let server: Server | undefined;
  let bound = false;
  let boundPort = options.port;
  let closed = false;
  let restarts = 0;
  let retryMs = baseRetryMs;
  let retryTimer: NodeJS.Timeout | undefined;
  let acceptErrorLoggedAt = Number.NEGATIVE_INFINITY;
  let acceptErrorsUnlogged = 0;

  function scheduleRebind(): void {
    if (closed || retryTimer !== undefined) return;
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, maxRetryMs);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      restarts += 1;
      void bind();
    }, wait);
    retryTimer.unref();
  }

  function bind(): Promise<void> {
    return new Promise((resolve) => {
      if (closed) {
        resolve();
        return;
      }
      const next = createServer((req, res) => options.proxy.handle(req, res));
      next.maxConnections = MAX_CONNECTIONS;
      // A stream can be open for a long time. Only a stalled header is cut.
      next.requestTimeout = 0;
      next.headersTimeout = 30_000;
      next.keepAliveTimeout = 60_000;
      next.on("upgrade", (req, socket) =>
        options.proxy.handleUpgrade(req, socket),
      );
      next.on("clientError", (_error, socket) => {
        if (socket.writable)
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        else socket.destroy();
      });
      let settledOnce = false;
      next.on("error", (error: NodeJS.ErrnoException) => {
        if (server === next) {
          // Bound, so this is the accept loop's, and Node keeps accepting
          // once descriptors free up. Serving on is the recovery.
          const now = Date.now();
          if (now - acceptErrorLoggedAt < ACCEPT_ERROR_LOG_MS) {
            acceptErrorsUnlogged += 1;
            return;
          }
          options.log(
            `model proxy listener on 127.0.0.1:${boundPort} could not accept a connection (${error.code ?? error.message}); still listening${acceptErrorsUnlogged > 0 ? `, ${acceptErrorsUnlogged} more since the last line` : ""}`,
          );
          acceptErrorLoggedAt = now;
          acceptErrorsUnlogged = 0;
          return;
        }
        options.log(
          `model proxy listener on 127.0.0.1:${boundPort} failed (${error.code ?? error.message}); rebinding in ${Math.round(retryMs / 1000)}s`,
        );
        bound = false;
        next.close(() => undefined);
        next.closeAllConnections?.();
        scheduleRebind();
        if (!settledOnce) {
          settledOnce = true;
          resolve();
        }
      });
      next.on("close", () => {
        if (server !== next) return;
        bound = false;
        server = undefined;
        scheduleRebind();
      });
      next.listen(boundPort, "127.0.0.1", () => {
        const address = next.address();
        if (typeof address === "object" && address !== null)
          boundPort = address.port;
        server = next;
        bound = true;
        retryMs = baseRetryMs;
        options.log(`model proxy listening on 127.0.0.1:${boundPort}`);
        if (!settledOnce) {
          settledOnce = true;
          resolve();
        }
      });
    });
  }

  return {
    start: bind,
    listening: () => bound,
    port: () => boundPort,
    restarts: () => restarts,
    close: async () => {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      const current = server;
      server = undefined;
      bound = false;
      if (current === undefined) return;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
    },
  };
}
