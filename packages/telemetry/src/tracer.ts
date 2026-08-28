// OpenTelemetry distributed tracing for @oxagen/telemetry.
// Vendor-neutral OTLP trace exporter with head-based sampling.
//
// Design:
// - @opentelemetry/api provides a global no-op tracer when the SDK is not
//   initialised. All span creation / context reads degrade gracefully to
//   no-ops when OTEL_EXPORTER_OTLP_ENDPOINT is unset.
// - initTracer() is called ONCE per process at bootstrap time. It is safe
//   to call from server components, edge functions, and service entrypoints.
// - PII safety: an attribute allowlist (ALLOWED_SPAN_ATTRIBUTES) ensures
//   that prompt text, user data, and secrets can never be attached to a span.
//   Use setSpanAttrs() — never set attributes directly from call-site code.
// - Async-safe: BatchSpanProcessor sends spans in background goroutine-style
//   workers; hot-path latency impact is negligible.
// - Rollback: leave OTEL_EXPORTER_OTLP_ENDPOINT unset → all calls are no-ops.

import {
  trace,
  SpanStatusCode,
  SpanKind,
  type Span,
  type Tracer,
  type Attributes,
} from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { resourceFromAttributes } from "@opentelemetry/resources";

// ── Service identity ──────────────────────────────────────────────────────────

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "oxagen";
const SERVICE_VERSION = process.env.npm_package_version ?? "0.0.0";

// ── PII attribute allowlist ───────────────────────────────────────────────────
//
// ONLY these keys may be attached to spans. Anything not in this set is
// silently dropped by setSpanAttrs(). This prevents prompt text, user email,
// API keys, or other PII from leaking into the trace backend.

const ALLOWED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  // Capability / kernel
  "capability.name",
  "capability.surface",
  "capability.status",
  "capability.error_code",
  "capability.duration_ms",
  // AI call
  "ai.model",
  "ai.provider",
  "ai.surface",
  "ai.input_tokens",
  "ai.output_tokens",
  "ai.cached_tokens",
  "ai.cost_usd_micros",
  "ai.duration_ms",
  // Tool invocation
  "tool.name",
  "tool.status",
  "tool.risk_level",
  "tool.required_approval",
  "tool.latency_ms",
  "tool.input_size_bytes",
  "tool.output_size_bytes",
  // Tenant scope
  "tenant.org_id",
  "tenant.workspace_id",
  // Request correlation
  "request.id",
  "request.surface",
  // Error
  "error.class",
  "error.message",
  // OTEL semantic conventions
  "service.name",
  "service.version",
]);

// ── SDK singleton ─────────────────────────────────────────────────────────────

let _sdk: NodeSDK | null = null;
let _initialised = false;

/**
 * Bootstrap the OpenTelemetry SDK.
 *
 * Safe to call multiple times — only the first call has any effect.
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the function is a true no-op:
 * the SDK is never started and the global tracer remains the API's built-in
 * NoopTracer. All `withSpan()` / `currentTraceIds()` calls degrade gracefully.
 *
 * Sampling: configurable via standard OTEL env vars:
 *   OTEL_TRACES_SAMPLER=parentbased_traceidratio
 *   OTEL_TRACES_SAMPLER_ARG=0.1   # 10% head-based sampling
 * Default (when env vars unset): always-on sampler (100%).
 *
 * @param overrideExporter - Inject a test exporter; only used in tests.
 */
export function initTracer(overrideExporter?: SpanExporter): void {
  if (_initialised) return;
  _initialised = true;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint && !overrideExporter) {
    // No endpoint set and no test exporter → stay on the global NoopTracer.
    return;
  }

  const exporter =
    overrideExporter ??
    new OTLPTraceExporter({
      url: endpoint,
      // Optional collector auth/routing headers, driven by the standard OTEL
      // env var. Empty object when unset — no headers attached.
      headers: parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
    });

  _sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),
    // BatchSpanProcessor: async, non-blocking, configurable via env:
    //   OTEL_BSP_MAX_QUEUE_SIZE, OTEL_BSP_SCHEDULE_DELAY,
    //   OTEL_BSP_MAX_EXPORT_BATCH_SIZE, OTEL_BSP_EXPORT_TIMEOUT
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  _sdk.start();
}

/**
 * Parse the standard `OTEL_EXPORTER_OTLP_HEADERS` env var — a comma-separated
 * list of `key=value` pairs (per the OTEL spec) — into a header record for the
 * OTLP exporter. Values may themselves contain `=` (e.g. base64), so only the
 * first `=` splits each pair. Malformed pairs (no `=`, empty key) are skipped.
 * Returns `{}` when unset/empty so the exporter attaches no headers.
 *
 * @internal exported for tests.
 */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue; // no `=`, or empty key → skip
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/**
 * Gracefully flush remaining spans and shut down the SDK.
 * Call from process shutdown hooks (SIGTERM/SIGINT). No-op when unset.
 */
export async function shutdownTracer(): Promise<void> {
  if (_sdk) {
    await _sdk.shutdown();
    _sdk = null;
    _initialised = false;
  }
}

// ── Tracer access ─────────────────────────────────────────────────────────────

/**
 * Returns the OpenTelemetry `Tracer` for scope `name`.
 * When the SDK is not initialised this returns the API's built-in NoopTracer —
 * callers need not check before using it.
 */
export function getTracer(name: string = SERVICE_NAME): Tracer {
  return trace.getTracer(name, SERVICE_VERSION);
}

// ── PII-safe attribute setter ─────────────────────────────────────────────────

/**
 * Set span attributes using the allowlist. Unknown keys are silently dropped.
 * Always call this instead of `span.setAttributes(attrs)` directly.
 */
export function setSpanAttrs(span: Span, attrs: Attributes): void {
  const safe: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (ALLOWED_SPAN_ATTRIBUTES.has(k) && v !== undefined && v !== null) {
      safe[k] = v;
    }
  }
  span.setAttributes(safe);
}

// ── withSpan ─────────────────────────────────────────────────────────────────

/**
 * Execute `fn` inside an active OTEL span, propagating context across await
 * boundaries. Sets `SpanStatusCode.ERROR` on rejection and re-throws.
 *
 * The `attrs` parameter is passed through `setSpanAttrs()` — only allowlisted
 * keys are recorded; all others are silently dropped (PII safety).
 *
 * When OTEL is not initialised this is equivalent to calling `fn()` directly
 * (the noop tracer produces a noop span; no performance overhead).
 *
 * @example
 * const result = await withSpan("capability.invoke", {
 *   "capability.name": name,
 *   "tenant.org_id": ctx.orgId,
 * }, async (span) => {
 *   // ... handler runs here with active span context
 *   return handler(input, ctx);
 * });
 */
export async function withSpan<T>(
  spanName: string,
  attrs: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.INTERNAL,
      attributes: filteredAttrs(attrs),
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (err) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        span.end();
        throw err;
      }
    },
  );
}

/** Internal: filter attrs through allowlist before starting a span. */
function filteredAttrs(attrs: Attributes): Attributes {
  const safe: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (ALLOWED_SPAN_ATTRIBUTES.has(k) && v !== undefined && v !== null) {
      safe[k] = v;
    }
  }
  return safe;
}

// ── Trace context extraction ──────────────────────────────────────────────────

export interface TraceIds {
  /** 32-char lowercase hex trace id, or empty string when no span is active. */
  trace_id: string;
  /** 16-char lowercase hex span id, or empty string when no span is active. */
  span_id: string;
}

/**
 * Extract the current `trace_id` and `span_id` from the active OTEL span
 * context. Returns empty strings when no span is active (e.g. in background
 * jobs or when OTEL is not initialised).
 *
 * Use this to stamp ClickHouse rows for log↔trace correlation.
 */
export function currentTraceIds(): TraceIds {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) {
    return { trace_id: "", span_id: "" };
  }
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
  };
}

// ── Exports for testing internals ─────────────────────────────────────────────

/** @internal used by tests to reset the initialised flag between runs. */
export function __resetTracerForTesting(): void {
  _initialised = false;
  _sdk = null;
}

/** @internal expose allowed attributes set for test assertions. */
export { ALLOWED_SPAN_ATTRIBUTES, type ReadableSpan };
