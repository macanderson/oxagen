import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import type { AppEnv } from "../app";

// Typed error codes we duck-type from @oxagen/billing to avoid a direct dep.
type BillingErrorCode = "insufficient_credits" | "billing_suspended";
interface BillingError extends Error {
  readonly code: BillingErrorCode;
}

function isBillingError(err: unknown): err is BillingError {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  return code === "insufficient_credits" || code === "billing_suspended";
}

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

  // CapabilityError — map known codes to HTTP status codes.
  if (err instanceof CapabilityError) {
    if (err.code === "authz_denied") {
      logger.warn({ requestId, capability: err.capability, message: err.message }, "authz denied");
      return c.json(
        { error: { code: "forbidden", message: err.message }, requestId },
        403,
      );
    }
    if (err.code === "surface_denied") {
      logger.warn({ requestId, capability: err.capability, message: err.message }, "surface denied");
      return c.json(
        { error: { code: "forbidden", message: err.message }, requestId },
        403,
      );
    }
    if (err.code === "unknown_capability" || err.code === "no_handler") {
      logger.warn({ requestId, capability: err.capability, message: err.message }, "capability not found");
      return c.json(
        { error: { code: "not_found", message: err.message }, requestId },
        404,
      );
    }
    if (err.code === "invalid_input") {
      logger.warn({ requestId, capability: err.capability, message: err.message }, "invalid capability input");
      return c.json(
        { error: { code: "bad_request", message: err.message }, requestId },
        400,
      );
    }
    // invalid_output → 500 (server bug)
  }

  // Billing errors — map to 402 Payment Required.
  if (isBillingError(err)) {
    logger.warn({ requestId, code: err.code, message: err.message }, "billing gate");
    return c.json(
      { error: { code: err.code, message: err.message }, requestId },
      402,
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
