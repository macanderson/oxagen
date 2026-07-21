import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { requireEnv } from "@oxagen/config/env";
import { getPrincipalAttribution } from "@oxagen/tenancy";
import { currentTraceIds } from "./tracer";
import {
  getBreaker,
  type BreakerTransition,
  type CircuitBreaker,
} from "./circuit-breaker";
import { breakerEnvConfig } from "./breaker-config";

/**
 * Circuit breaker for the shared ClickHouse client. A degraded ClickHouse must
 * fail fast instead of every append/query piling onto a down store.
 *
 * Unlike the Neo4j/Stripe breakers (breaker-clients.ts), this one CANNOT record
 * its own transitions in ClickHouse — that is the very dependency that is down —
 * so it logs trips to stderr only. Writes here are overwhelmingly fire-and-forget
 * telemetry, so a `CircuitOpenError` just means "drop this row while ClickHouse
 * recovers", which callers already tolerate.
 */
function clickhouseBreaker(): CircuitBreaker {
  return getBreaker("clickhouse", {
    ...breakerEnvConfig(),
    onTransition: (t: BreakerTransition) =>
      process.stderr.write(
        `[circuit-breaker] ${t.key} ${t.from}->${t.to} (failures=${t.failureCount})` +
          (t.error ? ` err=${t.error}` : "") +
          "\n",
      ),
  });
}

// Singleton client per process. ClickHouse Cloud handles concurrency
// upstream; we just reuse a single keepalive connection pool.
let _client: ClickHouseClient | null = null;

export function clickhouse(): ClickHouseClient {
  if (_client) return _client;
  const env = requireEnv([
    "CLICKHOUSE_URL",
    "CLICKHOUSE_USERNAME",
    "CLICKHOUSE_PASSWORD",
    "CLICKHOUSE_DATABASE",
  ] as const);
  _client = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USERNAME,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DATABASE,
    clickhouse_settings: {
      // Every caller stamps timestamps with `new Date().toISOString()`
      // (`2026-06-05T12:00:00.000Z`). ClickHouse's default `basic`
      // date_time_input_format rejects the ISO `T`/`Z` form against a
      // DateTime64 column, surfacing as "Cannot parse input ... created_at"
      // on every insert (token_usage, tool_invocations, traces, spans,
      // events, audit_events) and on the DateTime64 query params in
      // sumTokenUsage. `best_effort` parses ISO-8601 with millisecond
      // precision into DateTime64(3). Set once on the singleton so all
      // datetime columns ingest correctly — no per-row format conversion.
      date_time_input_format: "best_effort",
    },
  });
  return _client;
}

export async function closeClickhouse(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}

export interface TokenUsageRollup {
  metric:
    | "tokens_input"
    | "tokens_output"
    | "tokens_cached"
    | "tokens_cache_write"
    | "executions";
  quantity: number;
  costMicros: bigint;
}

/**
 * Sum token_usage rows for an org between two timestamps.
 * Used by billing.usage.getCurrentPeriodUsage and the scheduled
 * billing.rollup-usage Inngest function.
 */
export async function sumTokenUsage(args: {
  orgId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<TokenUsageRollup[]> {
  const ch = clickhouse();
  // Aggregating in ClickHouse rather than pulling raw rows keeps the
  // payload bounded regardless of usage volume. Breaker-guarded so a degraded
  // store fails fast rather than stalling the billing rollup.
  const result = await clickhouseBreaker().exec(() =>
    ch.query({
      query: `
      SELECT
        sum(input_tokens)  AS input_tokens,
        sum(output_tokens) AS output_tokens,
        sum(cached_tokens) AS cached_tokens,
        sum(cache_write_tokens) AS cache_write_tokens,
        sum(cost_usd_micros) AS cost_micros,
        count()            AS row_count
      FROM token_usage
      WHERE org_id = {orgId:UUID}
        AND created_at >= {periodStart:DateTime64(3)}
        AND created_at <  {periodEnd:DateTime64(3)}
    `,
      query_params: {
        orgId: args.orgId,
        periodStart: args.periodStart.toISOString().replace("Z", ""),
        periodEnd: args.periodEnd.toISOString().replace("Z", ""),
      },
      format: "JSONEachRow",
    }),
  );
  type Row = {
    input_tokens: string;
    output_tokens: string;
    cached_tokens: string;
    cache_write_tokens: string;
    cost_micros: string;
    row_count: string;
  };
  const rows = (await result.json()) as Row[];
  const row = rows[0] ?? {
    input_tokens: "0",
    output_tokens: "0",
    cached_tokens: "0",
    cache_write_tokens: "0",
    cost_micros: "0",
    row_count: "0",
  };
  const totalCost = BigInt(row.cost_micros);
  return [
    {
      metric: "tokens_input",
      quantity: Number(row.input_tokens),
      costMicros: 0n,
    },
    {
      metric: "tokens_output",
      quantity: Number(row.output_tokens),
      costMicros: 0n,
    },
    {
      metric: "tokens_cached",
      quantity: Number(row.cached_tokens),
      costMicros: 0n,
    },
    {
      metric: "tokens_cache_write",
      quantity: Number(row.cache_write_tokens),
      costMicros: 0n,
    },
    // Total cost attributed to executions metric; per-metric cost requires
    // model-aware pricing that lands with the agent epic.
    {
      metric: "executions",
      quantity: Number(row.row_count),
      costMicros: totalCost,
    },
  ];
}

// Typed inserts. ClickHouse client accepts an array of plain objects per
// table; named exports here document the row shape inline so callers don't
// have to reference schema.sql.

export interface ExecutionLogRow {
  execution_id: string;
  /** NULL when the log line isn't tied to a specific execution step. */
  step_id: string | null;
  org_id: string;
  workspace_id: string;
  log_level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  metadata: string;
  created_at: string;
}

export interface EventRow {
  event_id: string;
  org_id: string;
  workspace_id: string;
  event_type: string;
  source_system: string;
  stream_offset: string | null;
  payload: string;
  emitted_at: string;
  /**
   * OTEL trace id (32-char lowercase hex). Stamped automatically by
   * insertEvents() via currentTraceIds(). Empty string when no trace active.
   */
  trace_id?: string;
  /** OTEL span id (16-char lowercase hex). */
  span_id?: string;
}

export type Surface =
  | "api"
  | "mcp"
  | "app"
  | "agent"
  | "runner"
  | "ingestion"
  | "";
// The provider that billed us for a call. Text models are Anthropic/OpenAI;
// image & video generation reach Google, Black Forest Labs (bfl), and xAI
// through the gateway, so the label set spans every vendor @oxagen/ai can route
// to. Stored as LowCardinality(String) in ClickHouse — widening this union needs
// no migration. "" means "could not be inferred from the model id".
export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "bfl"
  | "xai"
  | "meta"
  | "mistral"
  | "deepseek"
  | "";

export interface TokenUsageRow {
  /**
   * UUID of the execution step that drove this LLM/embedding call, or `null`
   * when there is no step (e.g. fire-and-forget ingestion embeddings). `null`
   * is coalesced to the nil UUID at the insert boundary (see `insertTokenUsage`
   * / `NIL_UUID`) because the underlying ClickHouse column is a non-nullable
   * sorting-key `UUID`. NEVER pass a non-UUID correlation string here — it makes
   * ClickHouse abort the whole row (CANNOT_PARSE_INPUT_ASSERTION_FAILED).
   */
  execution_step_id: string | null;
  org_id: string;
  workspace_id: string;
  model: string;
  provider: Provider;
  input_tokens: number;
  output_tokens: number;
  /**
   * Prompt-cache READ tokens (cache hits). A SUBSET of `input_tokens`, not
   * additive — the @oxagen/ai gateway normalizes `input_tokens` to the inclusive
   * total, so fresh input = `input_tokens - cached_tokens - cache_write_tokens`.
   */
  cached_tokens: number;
  /**
   * Prompt-cache WRITE tokens (cache creation), billed by the provider at a
   * premium (~1.25x base input on Anthropic, 5-min TTL). Also a subset of
   * `input_tokens`. Optional at the type boundary — non-text callers (embeddings,
   * image/video generation) never write cache, so they omit it and it coalesces
   * to 0 in `insertTokenUsage`, matching the ClickHouse column DEFAULT (migration
   * 0026). Text callers routed through `@oxagen/ai` forward the real count.
   */
  cache_write_tokens?: number;
  cost_usd_micros: number;
  /** Wall-clock for the LLM call (first request byte → final token). */
  duration_ms: number;
  surface: Surface;
  /** SHA-256 of the rendered prompt, first 16 bytes hex. PII-free cohort key. */
  prompt_hash: string;
  created_at: string;
  /**
   * OTEL trace id (32-char lowercase hex) of the enclosing distributed trace.
   * Stamped automatically by insertTokenUsage() via currentTraceIds().
   * Empty string when no trace is active (OTEL not initialised or no active span).
   */
  trace_id?: string;
  /** OTEL span id (16-char lowercase hex) of the enclosing span. */
  span_id?: string;
  /**
   * Acting IAM principal uuid (migration 0023). Stamped automatically by
   * insertTokenUsage() from the ambient tenant scope
   * (@oxagen/tenancy getPrincipalAttribution) — same pattern as trace_id.
   * Nil UUID when no principal was resolved. Explicit caller values win.
   */
  principal_id?: string;
  /** "human" | "agent" | "service", or '' when no principal was resolved. */
  principal_kind?: string;
  /** Originating human user uuid, or the nil UUID. */
  user_id?: string;
  /** Canonical capability the spend occurred inside, or ''. */
  capability_name?: string;
}

async function insertRows<T>(table: string, rows: readonly T[]): Promise<void> {
  if (rows.length === 0) return;
  // Batched JSONEachRow keeps a single round-trip per insert call;
  // callers should accumulate rows before invoking. Guarded by the ClickHouse
  // breaker so a down store fails fast instead of being hammered.
  await clickhouseBreaker().exec(() =>
    clickhouse().insert({ table, values: rows, format: "JSONEachRow" }),
  );
}

/**
 * The all-zeroes UUID. `token_usage.execution_step_id` is a NON-nullable `UUID`
 * column AND part of the table's sorting key `(org_id, created_at,
 * execution_step_id)`. ClickHouse forbids converting a key column to
 * `Nullable` after creation — `ALTER TABLE token_usage MODIFY COLUMN
 * execution_step_id Nullable(UUID)` fails with `ALTER_OF_COLUMN_IS_FORBIDDEN`
 * (code 524) even with `allow_nullable_key = 1`, so the only route to a true
 * Nullable key would be a full rebuild of this 365-day-retention billing table.
 *
 * That rebuild buys nothing here: no query joins or filters on
 * `execution_step_id` (it is purely a tertiary tie-breaker in the sort), so the
 * nil UUID is an equivalent "no execution step" sentinel — already the
 * established pattern for `workspace_id` (DEFAULT toUUID('0…0')). Callers
 * therefore express "no step" as `null`/`undefined`, and we coalesce to the nil
 * UUID here, at the single insert boundary, so a non-UUID string can never reach
 * the column. This is what eliminated the `CANNOT_PARSE_INPUT_ASSERTION_FAILED`
 * (code 27) flood: ingestion callers used to synthesize ids like
 * `embed:<nodeId>` / `dedup:<key>` / `embed-file:<key>` / the literal
 * `"unknown"`, which the UUID text parser over-read on and aborted the whole row.
 */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Principal attribution columns (migration 0023) for the current async
 * context, coalesced to their ClickHouse sentinels (nil UUID / '') so the
 * non-nullable columns always receive parseable values. Reads the ambient
 * tenant scope stamped by the kernel (runInTenantScope + runWithPrincipal);
 * never throws — a write outside any scope simply carries the sentinels.
 */
function currentPrincipalStamp(): {
  principal_id: string;
  principal_kind: string;
  user_id: string;
  capability_name: string;
} {
  const a = getPrincipalAttribution();
  return {
    principal_id: a.principalId ?? NIL_UUID,
    principal_kind: a.principalKind ?? "",
    user_id: a.userId ?? NIL_UUID,
    capability_name: a.capabilityName ?? "",
  };
}

export const insertExecutionLogs = (rows: readonly ExecutionLogRow[]) =>
  insertRows("execution_logs", rows);

// ── Local dev console capture (tools/scripts/dev.ts) ──────────────────────────
//
// One row per line of `pnpm dev`'s combined turbo stream. Written fire-and-forget
// from the dev orchestrator's log shipper so the terminal output that used to
// vanish on scroll is queryable. Local-only; 14-day TTL (see schema.sql dev_logs).
// No org/workspace scope — this is machine-level dev telemetry, not tenant data.
export interface DevLogRow {
  /** One id per `pnpm dev` invocation — groups a single session's stream. */
  dev_session: string;
  /** Emitting workspace, parsed from turbo's `pkg:task:` prefix (e.g. @oxagen/app). */
  service: string;
  /** "stdout" | "stderr". */
  stream: string;
  /** Heuristic level parsed from the line content. */
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /** ISO-8601; omit to let ClickHouse default the column to now64(3). */
  ts?: string;
  host?: string;
}

export const insertDevLogs = (rows: readonly DevLogRow[]) =>
  insertRows("dev_logs", rows);

// ── Durable-sandbox command output (spec: sandbox-session-lifecycle §5.2) ──────
//
// One row per line of a coding-session command's stdout/stderr, plus a
// 'system'/'debug' line per command (echo + exit + duration). Powers the sandbox
// inspector's log console; the debug toggle filters on `level`. Written
// fire-and-forget from ModalSandboxWorkspace.exec — never fail a run on a log write.
export interface SandboxLogRow {
  org_id: string;
  workspace_id: string;
  /** Opaque durable-session public id (sbx_…). */
  session_id: string;
  /** "stdout" | "stderr" | "system". */
  stream: string;
  /** "normal" (program output) | "debug" (command echoes, timings, plumbing). */
  level: "normal" | "debug";
  /** The command this line belongs to (truncated); "" for continuation lines. */
  command: string;
  /** Line ordinal within one command's capture, for stable in-command ordering. */
  seq: number;
  line: string;
  /** Exit code — only on the per-command 'system' line. */
  exit_code?: number | null;
  /** Duration ms — only on the per-command 'system' line. */
  duration_ms?: number | null;
  /** ISO-8601; omit to let ClickHouse default the column to now64(3). */
  ts?: string;
}

export const insertSandboxLogs = (rows: readonly SandboxLogRow[]) =>
  insertRows("sandbox_log_events", rows);

export const insertEvents = (rows: readonly EventRow[]) => {
  const { trace_id, span_id } = currentTraceIds();
  return insertRows(
    "events",
    rows.map((r) => ({
      ...r,
      trace_id: r.trace_id ?? trace_id,
      span_id: r.span_id ?? span_id,
    })),
  );
};
export const insertTokenUsage = (rows: readonly TokenUsageRow[]) => {
  const { trace_id, span_id } = currentTraceIds();
  const attribution = currentPrincipalStamp();
  return insertRows(
    "token_usage",
    // Coalesce the "no execution step" sentinel (null/undefined) to the nil UUID
    // so the non-nullable UUID key column always receives a parseable value.
    // Also stamp trace_id/span_id from the active OTEL context for log↔trace
    // join, and principal attribution from the ambient tenant scope
    // (migration 0023) — explicit caller values win over ambient ones.
    rows.map((r) => ({
      ...(r.execution_step_id == null
        ? { ...r, execution_step_id: NIL_UUID }
        : r),
      // Coalesce the optional cache-write count to 0 so non-text callers
      // (embeddings, image/video) never have to spell it out — matches the
      // ClickHouse column DEFAULT 0 (migration 0026).
      cache_write_tokens: r.cache_write_tokens ?? 0,
      trace_id: r.trace_id ?? trace_id,
      span_id: r.span_id ?? span_id,
      principal_id: r.principal_id ?? attribution.principal_id,
      principal_kind: r.principal_kind ?? attribution.principal_kind,
      user_id: r.user_id ?? attribution.user_id,
      capability_name: r.capability_name ?? attribution.capability_name,
    })),
  );
};

// Agent runtime epic (spec §9). One row per tool invocation. Analytics
// mirror of execution.tool_calls; durable record stays in Postgres.
export interface ToolInvocationRow {
  invocation_id: string;
  org_id: string;
  workspace_id: string;
  capability_name: string;
  message_id: string;
  parent_message_id: string | null;
  execution_step_id: string | null;
  status: "started" | "completed" | "failed" | "cancelled" | "timed_out";
  input_size_bytes: number;
  output_size_bytes: number;
  latency_ms: number;
  error_class: string | null;
  // empty string sentinel — column is LowCardinality(String) DEFAULT ''.
  external_provider: string;
  external_server_id: string | null;
  risk_level: "low" | "medium" | "high";
  required_approval: 0 | 1;
  surface: Surface;
  /** Empty string when the underlying capability isn't model-backed. */
  provider: Provider;
  created_at: string;
  /**
   * OTEL trace id (32-char lowercase hex). Stamped automatically by
   * insertToolInvocation() via currentTraceIds(). Empty string when no trace active.
   */
  trace_id?: string;
  /** OTEL span id (16-char lowercase hex). */
  span_id?: string;
  /**
   * Acting IAM principal uuid (migration 0023). Stamped automatically from
   * the ambient tenant scope — same pattern as trace_id. Nil UUID when no
   * principal was resolved. Explicit caller values win.
   */
  principal_id?: string;
  /** "human" | "agent" | "service", or '' when no principal was resolved. */
  principal_kind?: string;
  /** Originating human user uuid, or the nil UUID. */
  user_id?: string;
}

export const insertToolInvocation = (row: ToolInvocationRow) => {
  const { trace_id, span_id } = currentTraceIds();
  const attribution = currentPrincipalStamp();
  return insertRows("tool_invocations", [
    {
      ...row,
      trace_id: row.trace_id ?? trace_id,
      span_id: row.span_id ?? span_id,
      principal_id: row.principal_id ?? attribution.principal_id,
      principal_kind: row.principal_kind ?? attribution.principal_kind,
      user_id: row.user_id ?? attribution.user_id,
    },
  ]);
};

// ── Runtime error stream (0020_error_events.sql) ──────────────────────────────
//
// One row per high-severity/unhandled server error captured by captureError()
// (see error-reporting.ts). ClickHouse is the correct store for append-only
// runtime events. Distinct from the Postgres security_events audit trail.
export interface ErrorEventRow {
  error_id: string;
  /** Nil UUID when the error occurred before a tenant scope was resolved. */
  org_id: string | null;
  /** Nil UUID when org-level or pre-scope. */
  workspace_id: string | null;
  severity: "fatal" | "error" | "warn";
  /** Which runtime captured it. */
  source: "api" | "app" | "mcp" | "inngest" | "runner";
  /** Error constructor name, e.g. "TypeError". */
  error_class: string;
  /** Truncated error message (bounded by the caller). */
  message: string;
  /** Truncated stack trace (bounded by the caller). */
  stack: string;
  /** Capability name for kernel-invocation errors, else "". */
  capability: string;
  /** Request/correlation id, else "". */
  request_id: string;
  /** SHA-256(class + normalized message) prefix — stable grouping key. */
  fingerprint: string;
  created_at: string;
  /**
   * Agent execution id this error belongs to. Nil UUID when the error occurred
   * outside any execution (the join key `agent.debug.trace` reads by). Coalesced
   * to the nil UUID at the insert boundary, mirroring org_id/workspace_id.
   */
  execution_id?: string | null;
  /** Execution step id when the error is tied to a specific step, else null. */
  step_id?: string | null;
  /** OTEL trace id; stamped automatically from the active span when omitted. */
  trace_id?: string;
  /** OTEL span id; stamped automatically from the active span when omitted. */
  span_id?: string;
}

export const insertErrorEvents = (rows: readonly ErrorEventRow[]) => {
  const { trace_id, span_id } = currentTraceIds();
  return insertRows(
    "error_events",
    // Coalesce "no tenant scope" (null/undefined) to the nil UUID so the
    // UUID columns always receive a parseable value, and stamp trace context.
    rows.map((r) => ({
      ...r,
      org_id: r.org_id ?? NIL_UUID,
      workspace_id: r.workspace_id ?? NIL_UUID,
      // "no execution" → nil UUID (a non-UUID string over-reads the UUID parser
      // and aborts the whole row); "no step" → null (Nullable(UUID) column).
      execution_id: r.execution_id ?? NIL_UUID,
      step_id: r.step_id ?? null,
      trace_id: r.trace_id ?? trace_id,
      span_id: r.span_id ?? span_id,
    })),
  );
};

/**
 * Deterministic, PII-free cohort key for prompts. SHA-256, first 16 bytes
 * hex. Stable across runs so analytics can group "same prompt asked N
 * times" without the prompt text leaving Postgres `chat.messages`.
 */
export async function hashPrompt(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest).slice(0, 16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Map an AI SDK model id to its provider. Handles three shapes:
 *   - prefixed       `anthropic:claude-…`          (legacy colon form)
 *   - gateway        `bfl/flux-2-max`, `google/veo-3.0-…`  (creator/model)
 *   - bare           `claude-sonnet-5`, `gpt-4o`, `gpt-image-1`
 * The leading `creator` segment (split on `:` or `/`) is authoritative when it
 * names a known vendor; otherwise we fall back to recognising the model family
 * by id prefix. Covers every vendor @oxagen/ai routes to (text + image + video)
 * so token_usage.provider is never blank for a real call.
 */
export function providerFromModelId(modelId: string): Provider {
  const head = (modelId.split(/[:/]/)[0] ?? "").toLowerCase();
  switch (head) {
    case "anthropic":
    case "openai":
    case "google":
    case "bfl":
    case "xai":
    case "meta":
    case "mistral":
    case "deepseek":
      return head;
  }
  const id = modelId.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (
    id.startsWith("gpt") ||
    id.startsWith("dall-e") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("chatgpt") ||
    id.startsWith("davinci") ||
    id.startsWith("text-embedding")
  ) {
    return "openai";
  }
  if (
    id.startsWith("gemini") ||
    id.startsWith("veo") ||
    id.startsWith("imagen")
  )
    return "google";
  if (id.startsWith("flux")) return "bfl";
  if (id.startsWith("grok")) return "xai";
  return "";
}

// ── IAM audit events (OXA-1390, Phase 3) ─────────────────────────────────────
//
// One row per capability invocation. Written fire-and-forget from inside
// defineContract().invoke(). The hash_chain links each event to the previous
// one for the same (org_id, capability) pair; tamper-evidence is best-effort
// because concurrent calls may read the same prev_hash (documented in
// plan.md Phase 3 §Risks).

export interface AuditEventRow {
  occurred_at: string;
  event_id: string;
  org_id: string;
  workspace_id: string | null;
  capability: string;
  scope_kind: "org" | "workspace";
  scope_id: string;
  acting_principal_id: string;
  acting_principal_kind: "human" | "agent" | "service";
  human_principal_id: string | null;
  outcome: "allow" | "deny" | "pending_approval";
  decision_reason: string;
  target_kind: string | null;
  target_id: string | null;
  payload_hash: string;
  chain_hash: string;
  ip: string | null;
  ua: string | null;
  request_id: string;
  correlation_id: string | null;
  trace_jsonb: string;
}

/**
 * Insert a single IAM audit event. Caller is responsible for fire-and-forget
 * semantics (not awaiting unless auditing is in the critical path).
 */
export const insertAuditEvent = (row: AuditEventRow): Promise<void> =>
  insertRows("audit_events", [row]);

// ── Memory decay / reinforcement events (OXA-1374) ────────────────────────────
//
// One row per confidence change to an AgentMemory node. Callers write
// fire-and-forget; the table is append-only with a 365-day TTL.

export interface MemoryChangeRow {
  change_id: string;
  org_id: string;
  workspace_id: string;
  memory_id: string;
  node_ref: string;
  cause: "reinforced" | "decayed" | "manually_promoted" | "manually_forgotten";
  confidence_before: number;
  confidence_after: number;
  /**
   * Two-axis model (OXA-1374 follow-up): enforcement_score before/after this
   * change, for auditing the policy axis alongside confidence (the evidence
   * axis). Default 0 — most causes (e.g. decay) never touch enforcement.
   */
  enforcement_before?: number;
  enforcement_after?: number;
  occurred_at: string;
}

/**
 * Insert a single memory-change event. Caller is responsible for fire-and-forget
 * semantics (not awaiting unless auditing is in the critical path).
 */
export const insertMemoryChange = (row: MemoryChangeRow): Promise<void> =>
  insertRows("memory_changes", [
    { enforcement_before: 0, enforcement_after: 0, ...row },
  ]);

// ── Eval results (agent-eval protocol) ────────────────────────────────────────
//
// Append-only record of every agent-eval run, for measuring the code agent
// improving over time and catching behavioral regression per task. See the
// `eval_runs` / `eval_results` tables in schema.sql and the canonical
// improvement/regression queries in docs/cli/eval-results-schema.md.
//
// Protocol shape: a few typed core dimensions every harness shares, plus open
// `metrics` (numeric) and `labels` (string) maps so a NEW metric never needs a
// migration. Timestamps are optional — ClickHouse defaults them to now64()/now()
// when omitted; to FINALIZE a run, re-insert the same run_id (ReplacingMergeTree
// keeps the row with the latest updated_at).

/** Open numeric metric bag (e.g. cost_usd, tokens, latency_p50_ms, context_precision). */
export type EvalMetricsMap = Record<string, number>;
/** Open string label bag (e.g. failure_signature, error_class, judge_model, diff_sha). */
export type EvalLabelsMap = Record<string, string>;

/** Which agent-eval harness produced the row. Extend freely — it is a LowCardinality(String). */
export type EvalHarness =
  | "engram-golden"
  | "rag-eval"
  | "context-eval"
  | "terminal-bench"
  | "swe-bench"
  | (string & {});

/** Suite-level run header + rollup (one logical row per run; re-insert to finalize). */
export interface EvalRunRow {
  run_id: string;
  /** Logical experiment / sweep this run belongs to (groups a factorial or learning curve). */
  run_group?: string;
  /** Protocol version, so the row shape can evolve. Defaults to 1 in ClickHouse. */
  schema_version?: number;
  agent_name: string;
  /** The time axis for "improvement over time" — bump this per release. */
  agent_version: string;
  model: string;
  harness: EvalHarness;
  suite: string;
  suite_version?: string;
  git_sha?: string;
  git_branch?: string;
  environment?: string;
  config_hash?: string;
  // Ablation cell (runbook §5) + self-improvement axes (§7).
  graph_code?: 0 | 1;
  graph_exec?: 0 | 1;
  graph_mem?: 0 | 1;
  warm?: 0 | 1;
  /** Count of prior tasks of accumulated graph/memory state (the learning-curve x-axis). */
  history_depth?: number;
  seed?: number;
  n_tasks?: number;
  n_passed?: number;
  /** n_passed / n_tasks — the headline improvement/regression number. */
  resolved_rate?: number;
  metrics?: EvalMetricsMap;
  labels?: EvalLabelsMap;
  notes?: string;
  /** ISO-8601; defaults to now in ClickHouse. */
  started_at?: string;
  finished_at?: string;
  /** ReplacingMergeTree version — omit to default to now (so a later finalize wins). */
  updated_at?: string;
}

/** Per-(run, task) result detail for regression hunting. Append-only. */
export interface EvalResultRow {
  run_id: string;
  task_id: string;
  /** e.g. 'near-transfer' | 'far-transfer' | a domain — for stratified analysis. */
  task_group?: string;
  /** Seed/repeat index for this (run, task) so repeats don't collide. */
  repeat_idx?: number;
  // Denormalized slice dims so eval_results queries standalone (no join to eval_runs).
  harness: EvalHarness;
  suite: string;
  agent_name: string;
  agent_version: string;
  model: string;
  graph_code?: 0 | 1;
  graph_exec?: 0 | 1;
  graph_mem?: 0 | 1;
  warm?: 0 | 1;
  history_depth?: number;
  /** 1 = verifier/test passed (resolved@1). */
  passed?: 0 | 1;
  /** Continuous score where a benchmark provides one (else 0/1 mirrors `passed`). */
  reward?: number;
  metrics?: EvalMetricsMap;
  labels?: EvalLabelsMap;
  started_at?: string;
}

/**
 * Insert (or finalize) a run header. Re-inserting the same run_id with a later
 * updated_at replaces the prior row under ReplacingMergeTree — query with FINAL.
 * `metrics`/`labels` are coalesced to empty maps so the columns always receive a
 * value.
 */
export const insertEvalRun = (row: EvalRunRow): Promise<void> =>
  insertRows("eval_runs", [{ metrics: {}, labels: {}, ...row }]);

/** Batch-insert per-task results. No-ops on an empty array. */
export const insertEvalResults = (
  rows: readonly EvalResultRow[],
): Promise<void> =>
  insertRows(
    "eval_results",
    rows.map((r) => ({ metrics: {}, labels: {}, ...r })),
  );

/**
 * Read the most recent chain_hash for a given (org_id, capability) pair so the
 * next event can chain off it. Returns an empty string when no prior events
 * exist. Uses FINAL to ensure ReplacingMergeTree deduplication is applied
 * before we read.
 *
 * Race note: two concurrent invocations for the same (org_id, capability) may
 * read the same prev_hash and produce a forked chain. This is intentional —
 * chain hash provides best-effort tamper-evidence at the range level, not
 * strict per-event ordering. See plan.md Phase 3 §Risks.
 */
export async function latestAuditChainHash(args: {
  orgId: string;
  capability: string;
}): Promise<string> {
  const ch = clickhouse();
  const result = await clickhouseBreaker().exec(() =>
    ch.query({
      query: `
      SELECT chain_hash
      FROM audit_events FINAL
      WHERE org_id = {orgId:UUID}
        AND capability = {capability:String}
      ORDER BY occurred_at DESC
      LIMIT 1
    `,
      query_params: { orgId: args.orgId, capability: args.capability },
      format: "JSONEachRow",
    }),
  );
  type Row = { chain_hash: string };
  const rows = (await result.json()) as Row[];
  return rows[0]?.chain_hash ?? "";
}

// ── Anonymous CLI usage telemetry (usage_events, migration 0019) ─────────────
//
// One row per `oxagen` CLI invocation, written by POST /v1/telemetry/usage
// (apps/api/src/routes/v1/telemetry.usage.ts) AFTER the request body has
// already passed UsageEventPayloadSchema.strict() (usage-events.ts) — this
// row type mirrors that schema exactly, plus the server-stamped `timestamp`
// (never client-supplied; see usage-events.ts for why). Anonymous/aggregate
// only: no org/workspace scope, no user identity — see TELEMETRY.md.
export interface UsageEventRow {
  /** ISO-8601, stamped by the route handler at insert time. */
  timestamp: string;
  install_id: string;
  session_id: string;
  oxagen_version: string;
  os: string;
  arch: string;
  command: string;
  model_tier: "fast" | "balanced" | "precise" | "mixed" | "";
  best_of_n: number;
  graph_used: 0 | 1;
  pipeline_used: 0 | 1;
  tui: 0 | 1;
  headless: 0 | 1;
  byok: 0 | 1;
  tool_calls_json: string;
  step_count: number;
  duration_ms: number;
  error_type: string;
  exit_status: string;
}

/** Insert anonymous CLI usage events. No-ops on an empty array. */
export const insertUsageEvents = (rows: readonly UsageEventRow[]) =>
  insertRows("usage_events", rows);
