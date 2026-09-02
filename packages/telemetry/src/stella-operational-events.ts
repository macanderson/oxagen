import { chInsert } from "./tenant";

export type StellaOperationalOutcome =
  | "completed"
  | "error"
  | "failed"
  | "aborted"
  | "cancelled"
  | "indeterminate"
  | "verification_failed"
  | "goal_met"
  | "goal_unmet";

/**
 * Content-free execution rollup accepted by the ClickHouse writer.
 *
 * Tenant labels are deliberately absent. The API contract validates Stella's
 * compatibility labels, but the handler must drop them before this boundary;
 * chInsert stamps the authenticated ambient tenant scope.
 */
export interface StellaOperationalEventRow {
  schema: "stella.operational.v1";
  event_class: "execution_rollup";
  event_id: string;
  enrollment_id: string;
  provider: string;
  model: string;
  outcome: StellaOperationalOutcome;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_microusd: number;
  tool_call_count: number;
  changed_file_count: number;
  produced_output: boolean;
}

/**
 * Append authenticated Stella execution rollups to ClickHouse.
 *
 * The explicit projection prevents untyped runtime callers from smuggling
 * compatibility tenant labels or content fields through this storage seam.
 * received_at is server-owned and doubles as the ReplacingMergeTree version.
 * No-ops on an empty array, so an empty batch costs neither a tenant-scope
 * assertion nor a round-trip (matches insertEvalItemResults / insertRows).
 */
export async function insertStellaOperationalEvents(
  rows: readonly StellaOperationalEventRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const receivedAt = new Date().toISOString();
  const values = rows.map((row) => ({
    schema: row.schema,
    event_class: row.event_class,
    event_id: row.event_id,
    enrollment_id: row.enrollment_id,
    provider: row.provider,
    model: row.model,
    outcome: row.outcome,
    duration_ms: row.duration_ms,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cost_microusd: row.cost_microusd,
    tool_call_count: row.tool_call_count,
    changed_file_count: row.changed_file_count,
    produced_output: row.produced_output,
    received_at: receivedAt,
  }));

  await chInsert("stella_operational_events", values);
}
