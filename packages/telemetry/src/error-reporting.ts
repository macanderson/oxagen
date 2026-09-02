// error-reporting.ts — vendor-neutral, fire-and-forget error capture for the
// server runtimes (apps/api, apps/app server side, apps/mcp, inngest functions).
//
// Two sinks, both best-effort and non-throwing:
//   1. ClickHouse `error_events` — the durable, append-only runtime error
//      stream (the correct store for runtime events; see the four-store model
//      in CLAUDE.md). Always written.
//   2. ALERT_WEBHOOK_URL — an OPTIONAL outbound Slack-compatible webhook. Fires
//      a `{ text, blocks }` payload only when the env var is set. BYO webhook
//      (Slack / Mattermost / Discord incoming webhook, or any endpoint that
//      accepts that JSON). No Sentry/Datadog SDK — vendor neutrality is the
//      trust moat.
//
// captureError() NEVER throws and NEVER blocks the caller: it kicks off the
// inserts/POST and swallows every failure to stderr. Callers wire it at the
// unhandled/high-severity boundary of each runtime (Hono onError catch-all,
// Next onRequestError, the inngest global failure fn, the MCP security-error
// branch) so it only fires for genuinely-unhandled / high-severity errors.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { insertErrorEvents, type ErrorEventRow } from "./clickhouse";

/** Max characters retained for the error message stored/alerted. */
const MAX_MESSAGE_LEN = 2000;
/** Max characters retained for the stack trace stored/alerted. */
const MAX_STACK_LEN = 8000;
/** Webhook POST timeout (ms) — never let a slow collector wedge the caller. */
const WEBHOOK_TIMEOUT_MS = 3000;

export type ErrorSeverity = ErrorEventRow["severity"];
export type ErrorSource = ErrorEventRow["source"];

export interface CaptureErrorInput {
  /** The thrown value. Non-Error values are coerced (class "UnknownError"). */
  error: unknown;
  /** Which runtime is reporting. */
  source: ErrorSource;
  /** Defaults to "error". Use "fatal" for crashes, "warn" for soft failures. */
  severity?: ErrorSeverity;
  /** Tenant scope when known; omit/undefined → recorded under the nil UUID. */
  orgId?: string | null;
  workspaceId?: string | null;
  /** Capability name for kernel-invocation errors. */
  capability?: string | null;
  /** Request/correlation id when available. */
  requestId?: string | null;
  /**
   * Agent execution id, when the error was captured inside an agent run. Stamped
   * onto the row so `agent.debug.trace` (debug_with_trace) can join every error
   * for one execution. Omit/undefined → recorded under the nil UUID sentinel.
   */
  executionId?: string | null;
  /** Execution step id, when the error is tied to a specific step. */
  stepId?: string | null;
  /**
   * Optional human context prepended to the alert message (e.g.
   * "inngest fn agent.execute-subagent failed"). Not stored separately — folded
   * into the message so a single field drives both the row and the alert.
   */
  context?: string;
}

/** Normalise any thrown value into `{ name, message, stack }`. */
function normalizeError(error: unknown): {
  name: string;
  message: string;
  stack: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "",
      stack: error.stack ?? "",
    };
  }
  if (typeof error === "string") {
    return { name: "UnknownError", message: error, stack: "" };
  }
  // Objects with a message-ish shape (e.g. duck-typed errors from libs).
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name : "UnknownError";
    const message =
      typeof rec.message === "string" ? rec.message : safeStringify(error);
    const stack = typeof rec.stack === "string" ? rec.stack : "";
    return { name, message, stack };
  }
  return { name: "UnknownError", message: safeStringify(error), stack: "" };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated]` : s;
}

/**
 * Stable grouping key: SHA-256(class + normalized message), first 16 bytes hex.
 * The message is normalized by stripping long digit/hex runs (ids, timestamps,
 * addresses) so the same logical error groups regardless of interpolated values.
 * PII-free — never stores the raw message.
 *
 * @internal exported for tests.
 */
export function errorFingerprint(errorClass: string, message: string): string {
  const normalized = message
    .replace(/0x[0-9a-fA-F]+/g, "0x…")
    .replace(
      /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
      "<uuid>",
    )
    .replace(/\d{3,}/g, "<n>");
  return createHash("sha256")
    .update(`${errorClass}\n${normalized}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Capture a high-severity / unhandled server error. Fire-and-forget:
 * returns immediately, never throws, never blocks the caller. Records to
 * ClickHouse `error_events` and — when ALERT_WEBHOOK_URL is set — POSTs a
 * Slack-compatible alert.
 */
export function captureError(input: CaptureErrorInput): void {
  // Guard the whole thing: capture must never become a new failure source.
  try {
    const { name, message, stack } = normalizeError(input.error);
    const severity: ErrorSeverity = input.severity ?? "error";
    const fullMessage = input.context
      ? `${input.context}: ${message}`
      : message;
    const boundedMessage = truncate(fullMessage, MAX_MESSAGE_LEN);
    const fingerprint = errorFingerprint(name, message);

    const row: ErrorEventRow = {
      error_id: randomUUID(),
      org_id: input.orgId ?? null,
      workspace_id: input.workspaceId ?? null,
      severity,
      source: input.source,
      error_class: name,
      message: boundedMessage,
      stack: truncate(stack, MAX_STACK_LEN),
      capability: input.capability ?? "",
      request_id: input.requestId ?? "",
      fingerprint,
      created_at: new Date().toISOString(),
      // Coalesced to the nil UUID / null at the insert boundary
      // (insertErrorEvents) so a caller with no execution scope stays valid.
      execution_id: input.executionId ?? null,
      step_id: input.stepId ?? null,
    };

    // Sink 1: ClickHouse. Always attempted.
    void insertErrorEvents([row]).catch((err: unknown) => {
      logCaptureFailure("clickhouse", err);
    });

    // Sink 2: optional webhook alert.
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (webhookUrl) {
      void postAlertWebhook(webhookUrl, {
        severity,
        source: input.source,
        errorClass: name,
        message: boundedMessage,
        capability: input.capability ?? null,
        requestId: input.requestId ?? null,
        fingerprint,
      }).catch((err: unknown) => {
        logCaptureFailure("webhook", err);
      });
    }
  } catch (err) {
    logCaptureFailure("capture", err);
  }
}

interface AlertPayloadInput {
  severity: ErrorSeverity;
  source: ErrorSource;
  errorClass: string;
  message: string;
  capability: string | null;
  requestId: string | null;
  fingerprint: string;
}

/**
 * Build a Slack-compatible incoming-webhook payload. `text` is the fallback /
 * notification line; `blocks` render the structured detail in Slack-like
 * clients and are ignored by ones that only read `text` — so a single payload
 * works across Slack, Mattermost, and generic endpoints.
 *
 * @internal exported for tests.
 */
export function buildAlertPayload(input: AlertPayloadInput): {
  text: string;
  blocks: unknown[];
} {
  const icon =
    input.severity === "fatal" ? "🛑" : input.severity === "warn" ? "⚠️" : "🔴";
  const title = `${icon} [${input.source}] ${input.errorClass}`;
  const text = `${title}: ${input.message}`;
  const fields: string[] = [
    `*Severity:* ${input.severity}`,
    `*Source:* ${input.source}`,
  ];
  if (input.capability) fields.push(`*Capability:* ${input.capability}`);
  if (input.requestId) fields.push(`*Request:* ${input.requestId}`);
  fields.push(`*Fingerprint:* ${input.fingerprint}`);

  return {
    text,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${title}*\n${input.message}` },
      },
      {
        type: "section",
        fields: fields.map((f) => ({ type: "mrkdwn", text: f })),
      },
    ],
  };
}

async function postAlertWebhook(
  url: string,
  input: AlertPayloadInput,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildAlertPayload(input)),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Log a capture-pipeline failure to stderr as structured JSON. No pino dep in
 * @oxagen/telemetry — process.stderr keeps this dependency-free and matches
 * security.ts. Never emits the error payload (may contain PII) — only the sink
 * name and the failure reason.
 */
function logCaptureFailure(sink: string, err: unknown): void {
  try {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        msg: "error-reporting: capture sink failed",
        sink,
        err: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
  } catch {
    // Absolute last resort — do nothing rather than throw from a logger.
  }
}
