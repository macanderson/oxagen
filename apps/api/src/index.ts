import { serve } from "@hono/node-server";
import { PORTS } from "@oxagen/config";
import { app } from "./app";
import { bootstrap } from "./bootstrap";
import { apiAdmission } from "./middleware/admission";
import { logger } from "./middleware/logger";
import { drainOnSignal } from "./shutdown";

// Local / self-hosted entrypoint: a long-running Node server (tsx in dev).
// On Vercel the same Hono `app` is served as a serverless function — see
// `api/index.ts`. Both share `bootstrap()` so env validation, IAM wiring, and
// the security-event emitter are identical across surfaces (no drift).
//
// The await lives inside a function rather than at module top level because
// `build-node.mjs` bundles this file to CJS, and esbuild cannot emit a
// top-level await in that format at all — it is a hard build error, not a
// warning. `src/__tests__/entrypoint-cjs.test.ts` transforms this file with the
// same format/platform/target triple on every unit-test run, so reintroducing a
// top-level await here fails a test rather than a deploy.
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

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname,
      serverOptions: { requestTimeout: 30_000, headersTimeout: 10_000 },
    },
    (info) => {
      logger.info({ port: info.port, hostname }, "api listening");
    },
  );
  // A deploy sends SIGTERM and starts the next release on this port, so the
  // port closes at once and the requests in progress finish (#5318).
  drainOnSignal(server, logger);
  const metrics = setInterval(() => {
    logger.info({ event: "resource_budget", ...apiAdmission.snapshot() }, "api resource budget");
  }, 30_000);
  metrics.unref();
}

// A rejected bootstrap must kill the process rather than leave an unhandled
// rejection and a server that never started — the deploy health check reads
// "did not answer", and the node rolls back.
main().catch((error) => {
  logger.error({ err: error }, "api failed to start");
  process.exitCode = 1;
});
