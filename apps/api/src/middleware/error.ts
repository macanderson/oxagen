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
// budget stop) conflicts with the state the caller asked in. A model call the
// provider refused or failed (`ModelCallFailedError`) is an upstream failure,
// so a 502; its message names the provider's status and nothing the vendor
// said. The key Oxagen minted for the organisation reaching its daily ceiling
// (`AssistantModelKeyLimitError`, @oxagen/ai, ADR-131 §3) is a payment
// decision, so a 402; it used to fall through to the 500 catch-all.
export const ASSISTANT_TURN_ERROR_STATUS: Record<
  string,
  402 | 409 | 502 | 503
> = {
  engine_unavailable: 503,
  assistant_run_not_recorded: 503,
  engine_aborted: 409,
  model_call_failed: 502,
  assistant_model_key_limit: 402,
};

// A store that is up and refusing work it cannot take right now
// (`StoreOverloadedError`, @oxagen/telemetry): out of memory, at its
// concurrent-query limit, or behind on its merges. Duck-typed on the stable
// `code` the way the billing errors above are, so this middleware keeps
// mapping a refusal it recognises even from a package it does not import.
//
// The code exists to be told apart from a fault. Tacho ingest answered 500 when
// the production ClickHouse refused an insert for memory, so the enrolled host
// read backpressure as a server fault and shipped the same batch straight back
// into the same wall (#3662). A 503 with `Retry-After` says the true thing: the
// request was fine, the store cannot take it yet, ask again in N seconds.
interface StoreOverloadedError extends Error {
  readonly code: "store_overloaded";
  readonly retryAfterSeconds: number;
}

function isStoreOverloadedError(err: unknown): err is StoreOverloadedError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e.code === "store_overloaded" && typeof e.retryAfterSeconds === "number"
  );
}

// Embeddings the platform cannot produce (`EmbeddingUnavailableError`,
// @oxagen/ai, #4148): the Voyage key is missing or refused, or Voyage stayed
// down through the SDK's retries. The request was fine and the service cannot
// answer it, so a 503. Duck-typed on the stable `code` like the errors above.
// Voyage's own words go to the log, where the next funding or key lapse shows
// up in one line, and never to the caller.
interface EmbeddingUnavailableError extends Error {
  readonly code: "embedding_unavailable";
  readonly statusCode?: number;
  readonly providerMessage?: string;
}

function isEmbeddingUnavailableError(
  err: unknown,
): err is EmbeddingUnavailableError {
  if (!(err instanceof Error)) return false;
  return (err as { code?: unknown }).code === "embedding_unavailable";
}

function assistantTurnFailure(
  err: unknown,
): { code: string; status: 402 | 409 | 502 | 503 } | null {
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

  // A request body that is not JSON. `c.req.json()` surfaces the parse
  // failure as the runtime's SyntaxError, and the routes call it with no
  // try/catch of their own, so a client sending `{bad` used to get a 500 and
  // an error-stream capture for its own typo. The match is narrowed to a
  // SyntaxError whose message names JSON, which is how JSON.parse words every
  // failure. A SyntaxError from server code parsing stored JSON would land
  // here too and read as the client's fault; that is the cost of a duck-typed
  // match, and the message check keeps every other SyntaxError out of it.
  if (err instanceof SyntaxError && /\bJSON\b/.test(err.message)) {
    logger.warn({ requestId, message: err.message }, "malformed json body");
    return c.json(
      {
        error: {
          code: "bad_request",
          message: "Request body is not valid JSON",
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
  if (isStoreOverloadedError(err)) {
    // Seconds, whole and at least one, because that is what the header takes
    // and a `Retry-After: 0` invites the immediate retry this answer exists to
    // prevent.
    const retryAfterSeconds = Math.max(1, Math.ceil(err.retryAfterSeconds));
    logger.warn(
      { requestId, code: err.code, retryAfterSeconds, message: err.message },
      "store overloaded",
    );
    // Warn, and no captureError: a store asking for room is a condition to
    // watch, not an unhandled fault to page on. Alerting on it would bury the
    // faults this stream exists for under the noise of a busy afternoon.
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          retryAfterSeconds,
        },
        requestId,
      },
      503,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  if (isEmbeddingUnavailableError(err)) {
    logger.error(
      {
        requestId,
        code: err.code,
        providerStatus: err.statusCode,
        providerMessage: err.providerMessage,
        message: err.message,
      },
      "embeddings unavailable",
    );
    return c.json(
      { error: { code: err.code, message: err.message }, requestId },
      503,
    );
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
