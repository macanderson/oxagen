/**
 * The mechanical flattening of a `tacho/1.0` event into one ClickHouse
 * `tacho_events` row (docs/specs/tacho/data-model.md section 2).
 *
 * Envelope groups flatten to fixed column names; every body member is already
 * named as its column; the whole body is also kept as JSON text in `body`;
 * unpromoted upstream attributes ride in the `attrs` map. Tenant columns are
 * deliberately absent: the control plane stamps them from the API key scope.
 */
import { BODY_MEMBER_NAMES, type TachoEvent } from "./envelope";

export const ENVELOPE_COLUMNS = [
  // identity (2.1)
  "host_enrollment_id",
  "agent_key",
  "agent_principal_id",
  "initiating_principal_id",
  "runtime",
  "harness",
  "harness_version",
  "wrapper_version",
  "wrapper_attestation",
  "fidelity",
  "enforcement_tier",
  "fleet_id",
  // anthropic observations (2.2)
  "anthropic_user_id_hash",
  "anthropic_user_email",
  "anthropic_account_uuid",
  "anthropic_account_id",
  "anthropic_org_uuid",
  "api_key_source",
  // session, causality, ordering (2.3)
  "session_uuid",
  "harness_session_id",
  "root_session_uuid",
  "parent_session_uuid",
  "subagent_id",
  "subagent_type",
  "spawn_depth",
  "spawn_tool_use_id",
  "seq",
  "event_id",
  "event_id_idem",
  "ts",
  "turn_seq",
  "prompt_id",
  "turn_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "harness_event_sequence",
  // kind and source (2.4)
  "kind",
  "source",
  "hook_event_name",
  "hook_source_kind",
  "otel_event_name",
  // context (2.5)
  "cwd",
  "project_dir",
  "git_branch",
  "git_head_sha",
  "git_remote_digest",
  "git_dirty",
  "worktree_path",
  "worktree_branch",
  "permission_mode",
  "effort",
  "context_model",
  "entrypoint",
  "query_source",
  "session_kind",
  "terminal_type",
  "app_version",
  "output_style",
  // host (2.14)
  "hostname_digest",
  "os_type",
  "os_version",
  "host_arch",
  "os_user_digest",
  "claude_pid",
  "claude_ppid",
  "claude_parent_process",
  "claude_execpath",
  "is_child_session",
  "bridge_session_id",
  "has_tty",
  // chain and content (2.13, 2.15)
  "prev_hash",
  "hash",
  "content_digest",
  "bytes_ref",
  "redactions",
  "raw_source_digest",
  "body",
  "attrs",
] as const;

export type EnvelopeColumn = (typeof ENVELOPE_COLUMNS)[number];
export type BodyColumn = (typeof BODY_MEMBER_NAMES)[number];

/** Every column of `tacho_events` except the server-stamped ones. */
export const TACHO_EVENT_COLUMNS: ReadonlyArray<EnvelopeColumn | BodyColumn> = [
  ...ENVELOPE_COLUMNS,
  ...BODY_MEMBER_NAMES,
];

/** Columns the control plane writes, never the producer. */
export const SERVER_STAMPED_COLUMNS = [
  "org_id",
  "workspace_id",
  "received_at",
  "chain_verified",
] as const;

export type TachoEventRow = Record<string, unknown>;

/** Objects, and arrays holding anything but primitives, become JSON text. */
function needsJsonText(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (!Array.isArray(value)) {
    return true;
  }
  return value.some((item) => item !== null && typeof item === "object");
}

function jsonText(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

/** Flatten one event into a row keyed by column name. Undefined members are omitted. */
export function flattenEvent(event: TachoEvent): TachoEventRow {
  const row: TachoEventRow = {
    host_enrollment_id: event.agent.host_enrollment_id,
    agent_key: event.agent.agent_key,
    agent_principal_id: event.agent.agent_principal_id,
    initiating_principal_id: event.agent.initiating_principal_id,
    runtime: event.agent.runtime,
    harness: event.agent.harness,
    harness_version: event.agent.harness_version,
    wrapper_version: event.agent.wrapper_version,
    wrapper_attestation: event.agent.attestation,
    fidelity: event.fidelity,
    enforcement_tier: event.agent.enforcement_tier,
    fleet_id: event.agent.fleet_id,

    anthropic_user_id_hash: event.anthropic?.user_id_hash,
    anthropic_user_email: event.anthropic?.user_email,
    anthropic_account_uuid: event.anthropic?.account_uuid,
    anthropic_account_id: event.anthropic?.account_id,
    anthropic_org_uuid: event.anthropic?.org_uuid,
    api_key_source: event.anthropic?.api_key_source,

    session_uuid: event.session_uuid,
    harness_session_id: event.session_id,
    root_session_uuid: event.root_session_uuid,
    parent_session_uuid: event.parent_session_uuid,
    subagent_id: event.subagent?.subagent_id,
    subagent_type: event.subagent?.subagent_type,
    spawn_depth: event.subagent?.spawn_depth,
    spawn_tool_use_id: event.subagent?.spawn_tool_use_id,
    seq: event.seq,
    event_id: event.event_id,
    event_id_idem: event.event_id_idem,
    ts: event.ts,
    turn_seq: event.turn?.turn_seq,
    prompt_id: event.turn?.prompt_id,
    turn_id: event.turn?.turn_id,
    trace_id: event.span?.trace_id,
    span_id: event.span?.span_id,
    parent_span_id: event.span?.parent_span_id,
    harness_event_sequence: event.harness_event_sequence,

    kind: event.kind,
    source: event.source,
    hook_event_name: event.hook_event_name,
    hook_source_kind: event.hook_source_kind,
    otel_event_name: event.otel_event_name,

    cwd: event.context?.cwd,
    project_dir: event.context?.project_dir,
    git_branch: event.context?.git_branch,
    git_head_sha: event.context?.git_head_sha,
    git_remote_digest: event.context?.git_remote_digest,
    git_dirty: event.context?.git_dirty,
    worktree_path: event.context?.worktree_path,
    worktree_branch: event.context?.worktree_branch,
    permission_mode: event.context?.permission_mode,
    effort: event.context?.effort,
    context_model: event.context?.model,
    entrypoint: event.context?.entrypoint,
    query_source: event.context?.query_source,
    session_kind: event.context?.session_kind,
    terminal_type: event.context?.terminal_type,
    app_version: event.context?.app_version,
    output_style: event.context?.output_style,

    hostname_digest: event.host?.hostname_digest,
    os_type: event.host?.os_type,
    os_version: event.host?.os_version,
    host_arch: event.host?.host_arch,
    os_user_digest: event.host?.os_user_digest,
    claude_pid: event.host?.claude_pid,
    claude_ppid: event.host?.claude_ppid,
    claude_parent_process: event.host?.claude_parent_process,
    claude_execpath: event.host?.claude_execpath,
    is_child_session: event.host?.is_child_session,
    bridge_session_id: event.host?.bridge_session_id,
    has_tty: event.host?.has_tty,

    prev_hash: event.prev_hash,
    hash: event.hash,
    content_digest: event.content?.digest,
    bytes_ref: event.content?.bytes_ref,
    redactions: jsonText(event.content?.redactions ?? []),
    raw_source_digest: event.raw_source_digest,
    body: JSON.stringify(event.body),
    attrs: event.attrs,
  };

  const bodyRecord = event.body as Record<string, unknown>;
  for (const name of BODY_MEMBER_NAMES) {
    const value = bodyRecord[name];
    if (value === undefined) {
      continue;
    }
    row[name] = needsJsonText(value) ? JSON.stringify(value) : value;
  }

  for (const key of Object.keys(row)) {
    if (row[key] === undefined) {
      delete row[key];
    }
  }
  return row;
}
