/**
 * The `tacho_events` ClickHouse table, derived from the `tacho/1.0` envelope
 * (docs/specs/tacho/data-model.md section 2) so the column set cannot drift
 * from the schema: envelope columns carry explicit types here, and every body
 * member's type is read off its Zod definition (integer bounds map to
 * UInt8/16/32/64, enums to LowCardinality, string arrays to Array(String),
 * open JSON to String). `tacho-events-ddl.test.ts` asserts the committed
 * migration equals this generator's output.
 */
import { BODY_FACTS_SHAPE, ENVELOPE_COLUMNS } from "@oxagen/tacho";
import { z } from "zod";

export const TACHO_EVENTS_TABLE = "tacho_events";

/** Explicit types for the envelope-derived columns (data-model 2.1 to 2.5, 2.13, 2.14). */
const ENVELOPE_COLUMN_TYPES: Record<(typeof ENVELOPE_COLUMNS)[number], string> =
  {
    host_enrollment_id: "String",
    agent_key: "String",
    agent_principal_id: "String",
    initiating_principal_id: "String",
    runtime: "LowCardinality(String)",
    harness: "LowCardinality(String)",
    harness_version: "LowCardinality(String)",
    wrapper_version: "LowCardinality(String)",
    wrapper_attestation: "String",
    fidelity: "LowCardinality(String)",
    enforcement_tier: "LowCardinality(String)",
    fleet_id: "String",
    anthropic_user_id_hash: "String",
    anthropic_user_email: "String",
    anthropic_account_uuid: "String",
    anthropic_account_id: "String",
    anthropic_org_uuid: "String",
    api_key_source: "LowCardinality(String)",
    session_uuid: "UUID",
    harness_session_id: "String",
    root_session_uuid: "UUID",
    parent_session_uuid: "Nullable(UUID)",
    subagent_id: "String",
    subagent_type: "LowCardinality(String)",
    spawn_depth: "UInt8",
    spawn_tool_use_id: "String",
    seq: "UInt64",
    event_id: "String",
    event_id_idem: "String",
    ts: "DateTime64(3, 'UTC')",
    turn_seq: "Nullable(UInt32)",
    prompt_id: "String",
    turn_id: "String",
    trace_id: "String",
    span_id: "String",
    parent_span_id: "String",
    harness_event_sequence: "Nullable(UInt64)",
    kind: "LowCardinality(String)",
    source: "LowCardinality(String)",
    hook_event_name: "LowCardinality(String)",
    hook_source_kind: "LowCardinality(String)",
    otel_event_name: "LowCardinality(String)",
    cwd: "String",
    project_dir: "String",
    git_branch: "String",
    git_head_sha: "String",
    git_remote_digest: "String",
    git_dirty: "Nullable(Bool)",
    worktree_path: "String",
    worktree_branch: "String",
    permission_mode: "LowCardinality(String)",
    effort: "LowCardinality(String)",
    context_model: "LowCardinality(String)",
    entrypoint: "LowCardinality(String)",
    query_source: "LowCardinality(String)",
    session_kind: "LowCardinality(String)",
    terminal_type: "LowCardinality(String)",
    app_version: "LowCardinality(String)",
    output_style: "LowCardinality(String)",
    hostname_digest: "String",
    os_type: "LowCardinality(String)",
    os_version: "LowCardinality(String)",
    host_arch: "LowCardinality(String)",
    os_user_digest: "String",
    claude_pid: "Nullable(UInt32)",
    claude_ppid: "Nullable(UInt32)",
    claude_parent_process: "LowCardinality(String)",
    claude_execpath: "String",
    is_child_session: "Nullable(Bool)",
    bridge_session_id: "String",
    has_tty: "Nullable(Bool)",
    prev_hash: "String",
    hash: "String",
    content_digest: "String",
    bytes_ref: "String",
    redactions: "String",
    raw_source_digest: "String",
    body: "String",
    attrs: "Map(String, String)",
  };

/** Columns the control plane writes, never the producer. */
const SERVER_COLUMN_TYPES: Array<[string, string]> = [
  ["org_id", "UUID"],
  ["workspace_id", "UUID"],
  ["received_at", "DateTime64(3, 'UTC')"],
  ["chain_verified", "Bool"],
];

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    return current;
  }
}

function integerType(schema: z.ZodNumber): string {
  const max = schema._def.checks.find(
    (check): check is { kind: "max"; value: number; inclusive: boolean } =>
      check.kind === "max",
  )?.value;
  if (max === undefined) return "Nullable(Float64)";
  if (max <= 255) return "Nullable(UInt8)";
  if (max <= 65_535) return "Nullable(UInt16)";
  if (max <= 4_294_967_295) return "Nullable(UInt32)";
  return "Nullable(UInt64)";
}

/** The ClickHouse type for one body member, from its Zod definition. */
export function bodyColumnType(schema: z.ZodTypeAny): string {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodEnum) return "LowCardinality(String)";
  if (inner instanceof z.ZodBoolean) return "Nullable(Bool)";
  if (inner instanceof z.ZodNumber) {
    const isInt = inner._def.checks.some((check) => check.kind === "int");
    return isInt ? integerType(inner) : "Nullable(Float64)";
  }
  if (inner instanceof z.ZodString) return "String";
  if (inner instanceof z.ZodArray) {
    const element = unwrap(inner.element as z.ZodTypeAny);
    return element instanceof z.ZodString ? "Array(String)" : "String";
  }
  // Open JSON (z.unknown) and nested objects travel as JSON text.
  return "String";
}

export interface TachoEventsColumn {
  name: string;
  type: string;
}

/** Every column of `tacho_events`, in DDL order. */
export function tachoEventsColumns(): TachoEventsColumn[] {
  const columns: TachoEventsColumn[] = SERVER_COLUMN_TYPES.slice(0, 2).map(
    ([name, type]) => ({ name, type }),
  );
  for (const name of ENVELOPE_COLUMNS) {
    columns.push({ name, type: ENVELOPE_COLUMN_TYPES[name] });
  }
  for (const [name, schema] of Object.entries(BODY_FACTS_SHAPE)) {
    columns.push({ name, type: bodyColumnType(schema as z.ZodTypeAny) });
  }
  for (const [name, type] of SERVER_COLUMN_TYPES.slice(2)) {
    columns.push({ name, type });
  }
  return columns;
}

/** The CREATE TABLE statement the migration carries. */
export function tachoEventsCreateTable(): string {
  const lines = tachoEventsColumns().map(
    ({ name, type }) => `  ${name} ${type}`,
  );
  return [
    `CREATE TABLE IF NOT EXISTS ${TACHO_EVENTS_TABLE} (`,
    lines.join(",\n"),
    ")",
    "ENGINE = ReplacingMergeTree(received_at)",
    "PARTITION BY toYYYYMM(ts)",
    "ORDER BY (org_id, workspace_id, session_uuid, seq)",
    "SETTINGS index_granularity = 8192;",
  ].join("\n");
}

/** The whole migration file body, including its header and indexes. */
export function tachoEventsMigration(): string {
  return [
    "-- 0027_tacho_events.sql",
    "--",
    "-- Every tacho/1.0 event from every wrapped agent, one row per event, every",
    "-- scalar the harness exposes as a typed column (docs/specs/tacho/data-model.md",
    "-- section 2). GENERATED by packages/telemetry/src/tacho-events-ddl.ts from the",
    "-- @oxagen/tacho envelope; tacho-events-ddl.test.ts fails if this file drifts",
    "-- from the generator. Tenant columns are stamped by chInsert from ambient",
    "-- scope, never from the producer. Repeated delivery of one (session_uuid,",
    "-- seq) collapses under FINAL; received_at is server-owned and selects the",
    "-- latest retry. Bodies are digested: no prompt, tool, or response bytes.",
    "",
    tachoEventsCreateTable(),
    "",
    `ALTER TABLE ${TACHO_EVENTS_TABLE} ADD INDEX IF NOT EXISTS tacho_events_idem_idx event_id_idem TYPE bloom_filter GRANULARITY 4;`,
    `ALTER TABLE ${TACHO_EVENTS_TABLE} ADD INDEX IF NOT EXISTS tacho_events_tool_use_idx tool_use_id TYPE bloom_filter GRANULARITY 4;`,
    `ALTER TABLE ${TACHO_EVENTS_TABLE} ADD INDEX IF NOT EXISTS tacho_events_kind_idx kind TYPE set(64) GRANULARITY 4;`,
    "",
  ].join("\n");
}
