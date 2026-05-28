import type { MiddlewareHandler } from "hono";
import pino from "pino";
import type { AppEnv } from "../app.js";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "api" },
});

export const requestLogger: MiddlewareHandler<AppEnv> = async (c, next) => {
  // One request id per inbound request; downstream capability handlers and
  // log lines all carry it for trace correlation.
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  const start = performance.now();
  await next();
  const durationMs = Math.round(performance.now() - start);
  logger.info(
    {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
    },
    "request",
  );
};
