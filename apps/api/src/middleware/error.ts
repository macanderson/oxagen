import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { isHandlerError, type HandlerErrorCode } from "@oxagen/oxagen";
import { captureError } from "@oxagen/telemetry";
import { logger } from "./logger";
import type { AppEnv } from "../app";

// Typed error codes we duck-type from @oxagen/billing to avoid a direct dep.
// Every one of these is a PAYMENT decision, not a server fault, so each maps to
// 402 Payment Required:
//   - insufficient_credits — the assistant turn's credit balance is empty
//                            (metering.ts; the ADR-053 platform-funded path)
//   - billing_suspended    — the org's subscription is suspended (dunning.ts)
//   - budget_exceeded      — a spend ceiling was reached (spend-budget.ts)
//   - gau_exhausted        — the org's month bucket of governed action units
//                            is empty and auto top-up could not run
//                            (gau-bucket.ts, ADR-055); carries an optional
//                            `reason` ("free_no_payment_method") the client
//                            prints as "add a payment method or wait"
//   - assistant_spend_cap  — the org spent its monthly cap of platform-paid
//                            assistant tokens (metering.ts, ADR-053 §3)
// The list is a hand-maintained mirror of the throwing classes in
// @oxagen/billing; BILLING_ERROR_CODES is exported so a test can assert the
// mirror stays complete rather than discovering a gap as a production 500.
export const BILLING_ERROR_CODES = [
  "insufficient_credits",
  "billing_suspended",
  "budget_exceeded",
  "gau_exhausted",
  "assistant_spend_cap",
] as const;
type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];
interface BillingError extends Error {
  readonly code: BillingErrorCode;
  /** A sub-code the client can branch on; only `gau_exhausted` sets one. */
  readonly reason?: string | null;
}

function isBillingError(err: unknown): err is BillingError {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as Record<string, unknown>).code;
  return (BILLING_ERROR_CODES as readonly string[]).includes(code as string);
}

// A TenantScopeError from @oxagen/tenancy, duck-typed on its code the way the
// kernel does, so this middleware takes no dependency on that package.
function isTenantScopeError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return code === "no_tenant_scope" || code === "invalid_tenant_scope";
}

// A handler's typed refusal (HandlerError, @oxagen/oxagen) reaches this
// middleware unchanged: the kernel rethrows what a handler throws. Each code is
// a client-side outcome with its own status; the `reason` sub-code travels in
// the envelope so a client can tell a last-owner conflict from any other.
const HANDLER_ERROR_STATUS: Record<HandlerErrorCode, 403 | 404 | 409> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

// The in-app agent's turn failures (`ask_assistant`, @oxagen/agent), by code.
// The engine being down and a turn the ledger could not record are the service
// being unable to answer; a turn cancelled before it answered (a per-turn
// budget stop) conflicts with the state the caller asked in.
export const ASSISTANT_TURN_ERROR_STATUS: Record<string, 409 | 503> = {
  engine_unavailable: 503,
  assistant_run_not_recorded: 503,
  engine_aborted: 409,
};

function assistantTurnFailure(
  err: unknown,
): { code: string; status: 409 | 503 } | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as Record<string, unknown>).code;
  if (typeof code !== "string") return null;
  const status = ASSISTANT_TURN_ERROR_STATUS[code];
  return status === undefined ? null : { code, status };
}

export const errorMiddleware: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get("requestId") ?? "unknown";

  if (err instanceof HTTPException) {
    logger.warn(
      { requestId, status: err.status, message: err.message },
      "http exception",
    );
    return c.json(
      {
        error: { code: errorCode(err.status), message: err.message },
        requestId,
      },
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
      logger.warn(
        { requestId, capability: err.capability, message: err.message },
        "authz denied",
      );
      return c.json(
        { error: { code: "forbidden", message: err.message }, requestId },
        403,
      );
    }
    if (err.code === "surface_denied") {
      logger.warn(
        { requestId, capability: err.capability, message: err.message },
        "surface denied",
      );
      return c.json(
        { error: { code: "forbidden", message: err.message }, requestId },
        403,
      );
    }
    if (err.code === "pending_approval") {
      // JIT access request: the action is denied NOW (403), but a request has
      // been created. Surface its id as `accessRequestId` — distinct from the
      // envelope's `requestId` (the request-correlation id) — so the client can
      // poll for approval. Additive to the deny shape; existing clients that
      // read only the 403 + code still work.
      logger.warn(
        {
          requestId,
          capability: err.capability,
          accessRequestId: err.accessRequestId,
          message: err.message,
        },
        "pending approval",
      );
      return c.json(
        {
          error: {
            code: "pending_approval",
            message: err.message,
            ...(err.accessRequestId
              ? { accessRequestId: err.accessRequestId }
              : {}),
          },
          requestId,
        },
        403,
      );
    }
    if (err.code === "unknown_capability" || err.code === "no_handler") {
      logger.warn(
        { requestId, capability: err.capability, message: err.message },
        "capability not found",
      );
      return c.json(
        { error: { code: "not_found", message: err.message }, requestId },
        404,
      );
    }
    if (err.code === "invalid_input") {
      logger.warn(
        { requestId, capability: err.capability, message: err.message },
        "invalid capability input",
      );
      return c.json(
        { error: { code: "bad_request", message: err.message }, requestId },
        400,
      );
    }
    // invalid_output → 500 (server bug)
  }

  if (isHandlerError(err)) {
    logger.warn(
      { requestId, code: err.code, reason: err.reason, message: err.message },
      "handler refusal",
    );
    return c.json(
      {
        error: { code: err.code, reason: err.reason, message: err.message },
        requestId,
      },
      HANDLER_ERROR_STATUS[err.code],
    );
  }

  // Billing errors — map to 402 Payment Required. The `reason` sub-code
  // travels in the envelope when the error carries one, the way a
  // HandlerError's does.
  if (isBillingError(err)) {
    const reason = typeof err.reason === "string" ? err.reason : undefined;
    logger.warn(
      { requestId, code: err.code, reason, message: err.message },
      "billing gate",
    );
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          ...(reason ? { reason } : {}),
        },
        requestId,
      },
      402,
    );
  }

  const turnFailure = assistantTurnFailure(err);
  if (turnFailure !== null) {
    const { code, status } = turnFailure;
    logger.warn(
      { requestId, code, message: err.message },
      "assistant turn failure",
    );
    return c.json({ error: { code, message: err.message }, requestId }, status);
  }
  // A tenant scope the kernel refused to enter (#3029). The two cases share
  // one code, so the message distinguishes them: a malformed id is a bad
  // request from the surface that built the context, and a missing scope is
  // the same to the caller. Either way it is a 4xx, never a 500.
  if (isTenantScopeError(err)) {
    logger.warn({ requestId, message: err.message }, "tenant scope refused");
    return c.json(
      {
        error: {
          code: "invalid_tenant_scope",
          message: err.message,
        },
        requestId,
      },
      400,
    );
  }

  logger.error({ requestId, err }, "unhandled error");
  // Fire-and-forget: record the unhandled 500 to the ClickHouse error stream and
  // (when ALERT_WEBHOOK_URL is set) fan a Slack-compatible alert. Only the true
  // catch-all reaches here — handled 4xx above return before this point.
  captureError({
    error: err,
    source: "api",
    severity: "error",
    orgId: c.get("orgId") ?? null,
    workspaceId: c.get("workspaceId") ?? null,
    requestId: requestId === "unknown" ? null : requestId,
  });
  return c.json(
    {
      error: { code: "internal_error", message: "Unexpected server error" },
      requestId,
    },
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
