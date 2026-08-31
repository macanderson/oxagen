/**
 * The worker's liveness endpoint.
 *
 * The shared node's deploy contract (oxagen-aws-infra `tools/node/README.md`)
 * is built around HTTP services: every artifact declares a `port`, and
 * `deploy-service.sh` polls `health_path` for up to a minute after start
 * before it lets the old container go. The worker claims runs from Postgres
 * and serves no users — but a worker that cannot answer "are you up" cannot
 * ride that deploy path, and inventing a second, HTTP-less deploy contract for
 * one service is a far worse trade than a ten-line listener.
 *
 * Deliberately `node:http` and nothing more: this package's only HTTP surface
 * is one route, and a framework here would be the largest dependency in it.
 */
import { createServer, type Server } from "node:http";

export interface HealthState {
  /** Flipped when SIGTERM begins the drain, so the check reports it honestly. */
  draining: boolean;
}

/**
 * Start the listener on `port`, loopback only — Caddy has no route to the
 * worker and nothing else should either; the audience is the node's own
 * health poll.
 */
export function startHealthServer(port: number, state: HealthState): Server {
  const startedAt = new Date().toISOString();
  const server = createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/") {
      res.writeHead(state.draining ? 503 : 200, {
        "content-type": "application/json",
      });
      res.end(
        JSON.stringify({ ok: !state.draining, startedAt, pid: process.pid }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  return server;
}
