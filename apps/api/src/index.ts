import { serve } from "@hono/node-server";
import { loadEnv } from "@oxagen/config/env";
import { PORTS } from "@oxagen/config";
import { bootstrapIAMRuntime } from "@oxagen/iam";
import { app } from "./app.js";
import { logger } from "./middleware/logger.js";

// Boot wrapper: env validates first; any missing required key crashes the
// process before Hono starts listening. Fail-closed per spec §11.
loadEnv();

// Wire the real IAM enforcement runtime into defineContract().invoke().
// Must run before any route handler can call contract.invoke() — here at the
// top-level of the process entry point that guarantees this ordering.
// Idempotent: safe to call again in test hot-reload scenarios.
bootstrapIAMRuntime();

const port = PORTS.api;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "api listening");
});
