import { serve } from "@hono/node-server";
import { loadEnv } from "@oxagen/config/env";
import { PORTS } from "@oxagen/config";
import { app } from "./app.js";
import { logger } from "./middleware/logger.js";

// Boot wrapper: env validates first; any missing required key crashes the
// process before Hono starts listening. Fail-closed per spec §11.
loadEnv();

const port = PORTS.api;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "api listening");
});
