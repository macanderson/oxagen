import { serve } from "@hono/node-server";
import { PORTS } from "@oxagen/config";
import { app } from "./app";
import { bootstrap } from "./bootstrap";
import { logger } from "./middleware/logger";

// Local / self-hosted entrypoint: a long-running Node server (tsx in dev).
// On Vercel the same Hono `app` is served as a serverless function — see
// `api/index.ts`. Both share `bootstrap()` so env validation, IAM wiring, and
// the security-event emitter are identical across surfaces (no drift).
//
// The await lives inside a function rather than at module top level because
// `build-node.mjs` bundles this file to CJS, and esbuild cannot emit a
// top-level await in that format at all — it is a hard build error, not a
// warning. Nothing caught it: that build has never run in CI.
async function main(): Promise<void> {
  // bootstrap() awaits assertRlsConnectionSafe before any traffic is accepted.
  await bootstrap();

  // `PORTS.api` is the default, not the answer. A self-hosted process has to
  // be placeable by whatever is running it, and this one runs on a shared
  // instance where Caddy decides which port it proxies to — a hardcoded port
  // makes that a code change.
  const port = Number(process.env.PORT ?? PORTS.api);

  // Loopback by default, and deliberately not `0.0.0.0`. On that instance this
  // runs with host networking beside Postgres, Neo4j and ClickHouse, so binding
  // every interface would publish the API on the instance's public address
  // directly, bypassing the TLS and routing Caddy provides. The security group
  // opens no port but 80 and 443, so this is defence in depth rather than the
  // only control — but the control that fails open is the one worth having.
  const hostname = process.env.HOST ?? process.env.HOSTNAME ?? "127.0.0.1";

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    logger.info({ port: info.port, hostname }, "api listening");
  });
}

// A rejected bootstrap must kill the process rather than leave an unhandled
// rejection and a server that never started — the deploy health check reads
// "did not answer", and the node rolls back.
main().catch((error) => {
  logger.error({ err: error }, "api failed to start");
  process.exitCode = 1;
});
