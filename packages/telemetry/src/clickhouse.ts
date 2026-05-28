import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { loadEnv } from "@oxagen/config/env";

// Singleton client per process. ClickHouse Cloud handles concurrency
// upstream; we just reuse a single keepalive connection pool.
let _client: ClickHouseClient | null = null;

export function clickhouse(): ClickHouseClient {
  if (_client) return _client;
  const env = loadEnv();
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
 * Sum token_usage rows for a tenant between two timestamps.
 * Used by billing.usage.getCurrentPeriodUsage and the scheduled
 * billing.rollup-usage Inngest function.
 */
export async function sumTokenUsage(args: {
  tenantId: string;
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
      WHERE tenant_id = {tenantId:UUID}
        AND created_at >= {periodStart:DateTime64(3)}
        AND created_at <  {periodEnd:DateTime64(3)}
    `,
    query_params: {
      tenantId: args.tenantId,
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
  tenant_id: string;
  workspace_id: string;
  log_level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  metadata: string;
  created_at: string;
}

export interface TraceRow {
  trace_id: string;
  execution_id: string;
  tenant_id: string;
  started_at: string;
  completed_at: string | null;
}

export interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  span_type: string;
  tenant_id: string;
  started_at: string;
  completed_at: string | null;
  metadata: string;
}

export interface EventRow {
  event_id: string;
  tenant_id: string;
  workspace_id: string;
  event_type: string;
  source_system: string;
  stream_offset: string | null;
  payload: string;
  emitted_at: string;
}

export interface ApiKeyEventRow {
  api_key_id: string;
  tenant_id: string;
  ip_address: string;
  user_agent: string;
  request_path: string;
  response_code: number;
  created_at: string;
}

export interface TokenUsageRow {
  execution_step_id: string;
  tenant_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd_micros: number;
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
  tenant_id: string;
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
  created_at: string;
}

export const insertToolInvocation = (row: ToolInvocationRow) =>
  insertRows("tool_invocations", [row]);

export const insertToolInvocations = (rows: readonly ToolInvocationRow[]) =>
  insertRows("tool_invocations", rows);
