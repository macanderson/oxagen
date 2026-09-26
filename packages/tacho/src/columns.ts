/**
 * The mechanical flattening of a `tacho/1.0` event into one ClickHouse
 * `tacho_events` row (docs/specs/tacho/data-model.md section 2).
 *
 * Envelope groups flatten to fixed column names; every body member is already
 * named as its column; the whole body is also kept as JSON text in `body`;
 * unpromoted upstream attributes ride in the `attrs` map. Tenant columns are
 * deliberately absent: the control plane stamps them from the API key scope.
 */
import { eventHashHolds } from "./chain";
import {
  BODY_MEMBER_NAMES,
  type TachoEvent,
  tachoEventSchema,
} from "./envelope";

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
    /**
     * The tier the SUBMITTER put on the envelope, not the one the platform
     * derived, despite the shared spelling.
     *
     * `tacho_sessions.enforcement_tier` in Postgres is the derived tier and is
     * the only one anything decides on: `tacho.events.ingest` computes it from
     * the host's mode and `tacho_hosts.gateway_last_seen_at`, written where the
     * control plane authorises a call on the host's own gateway credential.
     * That is what replay grading, command dispatch, cost rollups and the
     * export attestation read.
     *
     * This column is the raw envelope, projected per event for telemetry, and
     * nothing branches on it — checked across packages and apps
     * (discussion_r4036718127). It is kept because what an agent claimed is
     * worth having beside what Oxagen observed; that difference is signal, not
     * noise. Anything reading it must treat it as a claim. The name is a
     * hazard the ClickHouse table predates, and renaming it is a deployed
     * schema change for the manual store-migrate workflow rather than a line
     * in a security fix.
     */
    enforcement_tier: event.agent.enforcement_tier,
    fleet_id: event.agent.fleet_id,

    anthropic_user_id_hash: event.anthropic?.user_id_hash,
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

// ── The inverse: a row back to the event it was flattened from ──────────────

/**
 * Envelope groups and the column each member was flattened to. The order
 * of the groups is the order `unflattenEvent` resolves ambiguity in.
 */
const GROUP_COLUMNS = {
  turn: { turn_seq: "turn_seq", prompt_id: "prompt_id", turn_id: "turn_id" },
  span: {
    trace_id: "trace_id",
    span_id: "span_id",
    parent_span_id: "parent_span_id",
  },
  context: {
    cwd: "cwd",
    project_dir: "project_dir",
    git_branch: "git_branch",
    git_head_sha: "git_head_sha",
    git_remote_digest: "git_remote_digest",
    git_dirty: "git_dirty",
    worktree_path: "worktree_path",
    worktree_branch: "worktree_branch",
    permission_mode: "permission_mode",
    effort: "effort",
    model: "context_model",
    entrypoint: "entrypoint",
    query_source: "query_source",
    session_kind: "session_kind",
    terminal_type: "terminal_type",
    app_version: "app_version",
    output_style: "output_style",
  },
  host: {
    hostname_digest: "hostname_digest",
    os_type: "os_type",
    os_version: "os_version",
    host_arch: "host_arch",
    os_user_digest: "os_user_digest",
    claude_pid: "claude_pid",
    claude_ppid: "claude_ppid",
    claude_parent_process: "claude_parent_process",
    claude_execpath: "claude_execpath",
    is_child_session: "is_child_session",
    bridge_session_id: "bridge_session_id",
    has_tty: "has_tty",
  },
  anthropic: {
    user_id_hash: "anthropic_user_id_hash",
    account_uuid: "anthropic_account_uuid",
    account_id: "anthropic_account_id",
    org_uuid: "anthropic_org_uuid",
    api_key_source: "api_key_source",
  },
} as const satisfies Record<string, Record<string, EnvelopeColumn>>;

type GroupName = keyof typeof GROUP_COLUMNS;

/** Integer columns. ClickHouse returns a 64-bit integer as JSON text. */
const INTEGER_COLUMNS = new Set<string>([
  "seq",
  "spawn_depth",
  "turn_seq",
  "harness_event_sequence",
  "claude_pid",
  "claude_ppid",
]);

/**
 * The most candidates `unflattenEvent` hashes for one row. Eight independent
 * ambiguities fit; a row with more is left unresolved rather than searched.
 */
const MAX_CANDIDATES = 256;

/**
 * What a column read means for an optional member: a ClickHouse `String`
 * column reads `""` for a member the event never had, a `Nullable` column
 * reads `null`, and a row from `flattenEvent` omits it.
 */
function member(row: TachoEventRow, column: string): unknown {
  const value = row[column];
  if (value === undefined || value === null || value === "") return undefined;
  if (INTEGER_COLUMNS.has(column) && typeof value === "string") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value;
  }
  return value;
}

/** A required string member, which may legitimately be empty. */
function required(row: TachoEventRow, column: string): unknown {
  const value = row[column];
  return value === null || value === undefined ? "" : value;
}

function groupOf(
  row: TachoEventRow,
  columns: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, column] of Object.entries(columns)) {
    const value = member(row, column);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The spellings `ts` may have had. ClickHouse stores `DateTime64(3)` and
 * reads it back as `2026-09-08 10:06:03.000`; the producer wrote the profile
 * form, which `toProtocolTimestamp` renders with milliseconds. A whole second
 * may also have been written without a fraction. A finer fraction is gone.
 */
function tsSpellings(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?$/.exec(
    value,
  );
  if (!m) return [value];
  const [, day, time, frac] = m as unknown as [string, string, string, string?];
  const ms = (frac ?? "").slice(0, 3).padEnd(3, "0");
  const spellings = [`${day}T${time}.${ms}Z`];
  if (/^0*$/.test(frac ?? "")) spellings.push(`${day}T${time}Z`);
  return spellings;
}

/** Every subset of `count` flags, fewest set first. */
function* subsetsBySize(count: number): Generator<boolean[]> {
  const masks = Array.from({ length: 2 ** count }, (_, mask) => mask);
  const bits = (mask: number) => mask.toString(2).replace(/0/g, "").length;
  masks.sort((a, b) => bits(a) - bits(b) || a - b);
  for (const mask of masks) {
    yield Array.from({ length: count }, (_, i) => (mask & (1 << i)) !== 0);
  }
}

/**
 * Rebuild the sealed event a `tacho_events` row was flattened from, or null
 * when the row does not determine it.
 *
 * A row loses a little of its event. An envelope group whose members are all
 * absent may have been sent as `{}` or left out; `content` with no digest and
 * no redactions may have been `{ redactions: [] }` or absent; `spawn_depth`
 * reads 0 from ClickHouse whether it was 0 or unset; `ts` keeps milliseconds
 * only; and the address members of `anthropic` are never stored (#3072). So
 * this builds each reading the row allows and keeps the one that hashes to
 * the row's own `hash` (`eventHashHolds`). A match is proof: the hash is what
 * the chain links, and sha256 does not collide. When no reading matches, the
 * event is not guessed. The caller records that it was not carried.
 *
 * Accepts a row as `flattenEvent` writes it or as ClickHouse reads it back,
 * with `ts` as `toString(ts)`. `bytes_ref` must be the event's own member:
 * the control plane overwrites the stored column with where it kept the body
 * (`tachoEventRow`), so a reader of the stored row drops that column first.
 */
export function unflattenEvent(row: TachoEventRow): TachoEvent | null {
  const hash = row["hash"];
  if (typeof hash !== "string" || typeof row["body"] !== "string") return null;
  let body: unknown;
  let redactions: unknown;
  try {
    body = JSON.parse(row["body"]);
    redactions =
      typeof row["redactions"] === "string" && row["redactions"] !== ""
        ? JSON.parse(row["redactions"])
        : [];
  } catch {
    return null;
  }

  const agent: Record<string, unknown> = {
    agent_key: required(row, "agent_key"),
    fleet_id: required(row, "fleet_id"),
    runtime: required(row, "runtime"),
    harness: required(row, "harness"),
    wrapper_version: required(row, "wrapper_version"),
    ...groupOf(row, {
      harness_version: "harness_version",
      attestation: "wrapper_attestation",
      host_enrollment_id: "host_enrollment_id",
      agent_principal_id: "agent_principal_id",
      initiating_principal_id: "initiating_principal_id",
      enforcement_tier: "enforcement_tier",
    }),
  };

  const groups = Object.fromEntries(
    (Object.keys(GROUP_COLUMNS) as GroupName[]).map((name) => [
      name,
      groupOf(row, GROUP_COLUMNS[name]),
    ]),
  ) as Record<GroupName, Record<string, unknown>>;

  const subagentId = member(row, "subagent_id");
  const subagent: Record<string, unknown> | undefined =
    subagentId === undefined
      ? undefined
      : {
          subagent_id: subagentId,
          ...groupOf(row, {
            subagent_type: "subagent_type",
            spawn_depth: "spawn_depth",
            spawn_tool_use_id: "spawn_tool_use_id",
          }),
        };

  const content: Record<string, unknown> = {
    ...groupOf(row, { digest: "content_digest", bytes_ref: "bytes_ref" }),
    redactions,
  };
  const contentIsEmpty =
    Object.keys(content).length === 1 &&
    Array.isArray(redactions) &&
    redactions.length === 0;

  // The readings the row leaves open. Each flag flips one away from the
  // likelier spelling.
  const open: Array<(event: Record<string, unknown>) => void> = [];
  for (const name of Object.keys(GROUP_COLUMNS) as GroupName[]) {
    if (Object.keys(groups[name]).length === 0) {
      open.push((event) => {
        event[name] = {};
      });
    }
  }
  if (contentIsEmpty) {
    open.push((event) => {
      event["content"] = { redactions: [] };
    });
  }
  if (subagent !== undefined && subagent["spawn_depth"] === 0) {
    open.push((event) => {
      delete (event["subagent"] as Record<string, unknown>)["spawn_depth"];
    });
  }
  const spellings = tsSpellings(row["ts"]);
  if (spellings.length > 1) {
    open.push((event) => {
      event["ts"] = spellings[1];
    });
  }
  if (2 ** open.length > MAX_CANDIDATES) return null;

  const base = (): Record<string, unknown> => {
    const event: Record<string, unknown> = {
      v: "tacho/1.0",
      event_id: required(row, "event_id"),
      event_id_idem: required(row, "event_id_idem"),
      session_id: required(row, "harness_session_id"),
      session_uuid: required(row, "session_uuid"),
      root_session_uuid: required(row, "root_session_uuid"),
      seq: member(row, "seq"),
      ts: spellings[0],
      fidelity: required(row, "fidelity"),
      source: required(row, "source"),
      kind: required(row, "kind"),
      agent: { ...agent },
      attrs: { ...((row["attrs"] as Record<string, string>) ?? {}) },
      prev_hash: required(row, "prev_hash"),
      hash,
      body,
      ...groupOf(row, {
        parent_session_uuid: "parent_session_uuid",
        hook_event_name: "hook_event_name",
        hook_source_kind: "hook_source_kind",
        otel_event_name: "otel_event_name",
        harness_event_sequence: "harness_event_sequence",
        raw_source_digest: "raw_source_digest",
      }),
    };
    if (subagent !== undefined) event["subagent"] = { ...subagent };
    for (const name of Object.keys(GROUP_COLUMNS) as GroupName[]) {
      if (Object.keys(groups[name]).length > 0) {
        event[name] = { ...groups[name] };
      }
    }
    if (!contentIsEmpty) event["content"] = content;
    return event;
  };

  for (const flags of subsetsBySize(open.length)) {
    const candidate = base();
    flags.forEach((flip, i) => {
      if (flip) open[i]?.(candidate);
    });
    if (!eventHashHolds(candidate, hash)) continue;
    // The hash matched the reading; parsing it is the schema's word that the
    // reading is an event, and parsing must not change what was hashed.
    const parsed = tachoEventSchema.safeParse(candidate);
    if (
      parsed.success &&
      eventHashHolds(parsed.data as unknown as Record<string, unknown>, hash)
    ) {
      return parsed.data;
    }
  }
  return null;
}
