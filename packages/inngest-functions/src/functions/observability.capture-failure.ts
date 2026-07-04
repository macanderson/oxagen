import { createFunction } from "../create-function";
import { captureError } from "@oxagen/telemetry";
import { logger } from "../logger";

/**
 * Global durable-function failure capture.
 *
 * Inngest emits the internal `inngest/function.failed` event once per function
 * whose retries are fully exhausted (NOT on every intermediate retry). This
 * companion subscribes to that event for ALL functions — a single wiring point
 * that routes every terminal durable-job failure into the runtime error stream
 * (@oxagen/telemetry captureError → ClickHouse error_events + optional
 * ALERT_WEBHOOK_URL alert), the inngest analogue of the Hono onError and Next
 * onRequestError boundaries.
 *
 * Capturing here (rather than inside create-function's wrapHandler catch) is
 * deliberate: wrapHandler runs on every attempt, so capturing there would fire
 * an alert per retry. This fires exactly once, after the last retry.
 *
 * No retries on the capture fn itself and NonRetriable-by-nature (captureError
 * never throws) — a failure to record a failure must not spawn its own retry
 * storm.
 */

/** Shape of the `inngest/function.failed` event payload we read. */
interface FunctionFailedData {
  error?: { name?: string; message?: string; stack?: string };
  function_id?: string;
  run_id?: string;
  event?: { data?: Record<string, unknown> };
}

/** Pull tenant scope from the original event's data when present. */
function scopeFromOriginalEvent(data: FunctionFailedData): {
  orgId: string | null;
  workspaceId: string | null;
} {
  const original = data.event?.data ?? {};
  const orgId = typeof original.orgId === "string" ? original.orgId : null;
  const workspaceId =
    typeof original.workspaceId === "string" ? original.workspaceId : null;
  return { orgId, workspaceId };
}

export const [observabilityCaptureFailure] = createFunction(
  { id: "observability.capture-failure", retries: 0 },
  { event: "inngest/function.failed" },
  async ({ event }) => {
    const data = (event.data ?? {}) as FunctionFailedData;
    const functionId = data.function_id ?? "unknown";
    const runId = data.run_id ?? "";
    const { orgId, workspaceId } = scopeFromOriginalEvent(data);

    // Reconstruct an Error so captureError's normalizer records class + stack.
    const rawErr = data.error;
    const err = new Error(rawErr?.message ?? "durable function failed");
    if (rawErr?.name) err.name = rawErr.name;
    if (rawErr?.stack) err.stack = rawErr.stack;

    captureError({
      error: err,
      source: "inngest",
      severity: "error",
      orgId,
      workspaceId,
      requestId: runId || null,
      context: `inngest function ${functionId} failed`,
    });

    logger.warn(
      { functionId, runId, err: rawErr?.message },
      "observability.capture-failure: durable function failed",
    );

    return { functionId, runId, captured: true };
  },
);
