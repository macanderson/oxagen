import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { logger } from "./logger.js";
import type { AppEnv } from "../app.js";

export const errorMiddleware: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get("requestId") ?? "unknown";

  if (err instanceof HTTPException) {
    logger.warn({ requestId, status: err.status, message: err.message }, "http exception");
    return c.json(
      { error: { code: errorCode(err.status), message: err.message }, requestId },
      err.status,
    );
  }

  if (err instanceof ZodError) {
    logger.warn({ requestId, issues: err.issues }, "validation error");
    return c.json(
      {
        error: {
          code: "validation_error",
          message: "Invalid request payload",
          details: err.issues,
        },
        requestId,
      },
      400,
    );
  }

  logger.error({ requestId, err }, "unhandled error");
  return c.json(
    { error: { code: "internal_error", message: "Unexpected server error" }, requestId },
    500,
  );
};

function errorCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal_error";
  return "bad_request";
}
