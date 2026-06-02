import { serve } from "@hono/node-server";
import { PORTS } from "@oxagen/config";
import { app } from "./app";
import { bootstrap } from "./bootstrap";
import { logger } from "./middleware/logger";

// Local / self-hosted entrypoint: a long-running Node server (tsx in dev).
// On Vercel the same Hono `app` is served as a serverless function — see
// `api/index.ts`. Both share `bootstrap()` so env validation, IAM wiring, and
// the security-event emitter are identical across surfaces (no drift).
bootstrap();

const port = PORTS.api;
serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port }, "api listening");
});
