import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { requireEnv } from "@oxagen/config/env";

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
  metric: "tokens_input" | "tokens_output" | "tokens_cached" | "executions" | "tool_calls";
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
  // payload bounded regardless of usage volume.
  const result = await ch.query({
    query: `
      SELECT
        sum(input_tokens)  AS input_tokens,
        sum(output_tokens) AS output_tokens,
        sum(cached_tokens) AS cached_tokens,
        sum(cost_usd_micros) AS cost_micros,
        count()            AS row_count
      FROM token_usage
      WHERE org_id = {orgId:UUID}
        AND created_at >= {periodStart:DateTime64(3)}
        AND created_at <  {periodEnd:DateTime64(3)}
    `,
    query_params: {
      orgId: args.orgId,
      periodStart: args.periodStart.toISOString(),
      periodEnd: args.periodEnd.toISOString(),
    },
    format: "JSONEachRow",
  });
  type Row = {
    input_tokens: string;
    output_tokens: string;
    cached_tokens: string;
    cost_micros: string;
    row_count: string;
  };
  const rows = (await result.json()) as Row[];
  const row = rows[0] ?? {
    input_tokens: "0",
    output_tokens: "0",
    cached_tokens: "0",
    cost_micros: "0",
    row_count: "0",
  };
  const totalCost = BigInt(row.cost_micros);
  return [
    { metric: "tokens_input", quantity: Number(row.input_tokens), costMicros: 0n },
    { metric: "tokens_output", quantity: Number(row.output_tokens), costMicros: 0n },
    { metric: "tokens_cached", quantity: Number(row.cached_tokens), costMicros: 0n },
    // Total cost attributed to executions metric; per-metric cost requires
    // model-aware pricing that lands with the agent epic.
    { metric: "executions", quantity: Number(row.row_count), costMicros: totalCost },
  ];
}

// Typed inserts. ClickHouse client accepts an array of plain objects per
// table; named exports here document the row shape inline so callers don't
// have to reference schema.sql.

export interface ExecutionLogRow {
  execution_id: string;
  step_id: string;
  org_id: string;
  workspace_id: string;
  log_level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  metadata: string;
  created_at: string;
}

export interface TraceRow {
  trace_id: string;
  execution_id: string;
  org_id: string;
  started_at: string;
  completed_at: string | null;
}

export interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  span_type: string;
  org_id: string;
  started_at: string;
  completed_at: string | null;
  metadata: string;
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
}

export interface ApiKeyEventRow {
  api_key_id: string;
  org_id: string;
  ip_address: string;
  user_agent: string;
  request_path: string;
  response_code: number;
  created_at: string;
}

export type Surface = "api" | "mcp" | "app" | "runner" | "";
export type Provider = "anthropic" | "openai" | "";

export interface TokenUsageRow {
  execution_step_id: string;
  org_id: string;
  workspace_id: string;
  model: string;
  provider: Provider;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd_micros: number;
  /** Wall-clock for the LLM call (first request byte → final token). */
  duration_ms: number;
  surface: Surface;
  /** SHA-256 of the rendered prompt, first 16 bytes hex. PII-free cohort key. */
  prompt_hash: string;
  created_at: string;
}

async function insertRows<T>(table: string, rows: readonly T[]): Promise<void> {
  if (rows.length === 0) return;
  // Batched JSONEachRow keeps a single round-trip per insert call;
  // callers should accumulate rows before invoking.
  await clickhouse().insert({ table, values: rows, format: "JSONEachRow" });
}

export const insertExecutionLogs = (rows: readonly ExecutionLogRow[]) =>
  insertRows("execution_logs", rows);
export const insertTraces = (rows: readonly TraceRow[]) => insertRows("traces", rows);
export const insertSpans = (rows: readonly SpanRow[]) => insertRows("spans", rows);
export const insertEvents = (rows: readonly EventRow[]) => insertRows("events", rows);
export const insertApiKeyEvents = (rows: readonly ApiKeyEventRow[]) =>
  insertRows("api_key_events", rows);
export const insertTokenUsage = (rows: readonly TokenUsageRow[]) =>
  insertRows("token_usage", rows);

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
}

export const insertToolInvocation = (row: ToolInvocationRow) =>
  insertRows("tool_invocations", [row]);

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
 * Map an AI SDK model id to its provider. Handles both the prefixed form
 * (`anthropic:claude-…`) and the bare ids the AI SDK actually hands back from
 * `model.modelId` (`claude-sonnet-4-6`, `gpt-4o`, `text-embedding-3-small`),
 * so token_usage.provider is never blank for a real call.
 */
export function providerFromModelId(modelId: string): Provider {
  const head = modelId.split(":")[0] ?? "";
  if (head === "anthropic" || head === "openai") return head;
  const id = modelId.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (
    id.startsWith("gpt") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("chatgpt") ||
    id.startsWith("davinci") ||
    id.startsWith("text-embedding")
  ) {
    return "openai";
  }
  return "";
}

export const insertToolInvocations = (rows: readonly ToolInvocationRow[]) =>
  insertRows("tool_invocations", rows);

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
  const result = await ch.query({
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
  });
  type Row = { chain_hash: string };
  const rows = (await result.json()) as Row[];
  return rows[0]?.chain_hash ?? "";
}
