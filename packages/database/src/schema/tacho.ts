/**
 * Tacho: the Postgres side of the wrapper that records, gates, and evidences
 * agents Oxagen does not run (docs/specs/tacho/spec.md; column contract in
 * docs/specs/tacho/data-model.md section 3).
 *
 * ClickHouse holds every event (`tacho_events`); these tables hold what needs
 * RLS, joins, and indefinite retention: hosts, sessions, per-model and
 * per-file rollups, commands, control state, incidents, and checkpoints.
 *
 * Notes:
 *   - No cross-schema FK .references(); app-enforced FKs per CLAUDE.md.
 *   - Every table carries org_id + workspace_id NOT NULL -> standard
 *     tenant_isolation RLS (tenant-policy.manifest.ts).
 *   - Public id prefixes: tch_ hosts, tse_ sessions, tsm_ session models,
 *     tsf_ session files, trp_ run pull requests, tsc_ session commands,
 *     tcm_ control commands, tin_ incidents, tck_ checkpoints.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  appendOnlyAuditMixin,
  auditMixin,
  idMixin,
  orgScopeMixin,
} from "./_mixins";
import { tachoSchema } from "./_schemas";

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const TACHO_HOST_STATUSES = [
  "active",
  "paused",
  "suspended",
  "revoked",
] as const;
export const TACHO_HOST_MODES = ["observe", "enforce"] as const;
/**
 * The runtimes `tacho.sessions.runtime` is CHECKed to. Mirrored by
 * `TACHO_RUNTIMES` in `packages/tacho/src/envelope.ts` (a leaf package that
 * cannot import this one); `packages/handlers/src/tacho.runtimes.test.ts`
 * fails when the two lists drift, and `packages/database/src/schema/tacho.test.ts`
 * fails when the latest migration redefining `tacho_sessions_runtime_check`
 * does not carry every value here. Widening this list is a new Atlas
 * migration that drops and re-adds that constraint.
 */
export const TACHO_RUNTIMES = [
  "claude-code",
  "claude-agent-sdk",
  "custom",
  "stella",
  "proxy",
  "codex",
  "cursor",
] as const;
export const TACHO_SESSION_OUTCOMES = [
  "running",
  "completed",
  "aborted",
  "crashed",
  "unknown",
] as const;
/**
 * What sealed a session. `agent_stop` is the host's own end, a seal that
 * holds until the host seals an `agent_start` on the same chain, which
 * reopens it (ADR-172). `idle_timeout` is the control plane closing a session that sent no
 * event for `TACHO_IDLE_CLOSE_AFTER_MS`: a later event reopens it and a later
 * `agent_stop` replaces it. `operator` is a person sealing the run through
 * `seal_run` (ADR-169), final like the host's own. Null on an open session,
 * and on a session sealed before the column existed, which reads as
 * `agent_stop`.
 */
export const TACHO_SEAL_SOURCES = [
  "agent_stop",
  "idle_timeout",
  "operator",
] as const;
export type TachoSealSource = (typeof TACHO_SEAL_SOURCES)[number];
/**
 * How long a session may send nothing before the control plane closes it:
 * twelve hours, twice the host daemon's own idle sweep, so a daemon that is
 * running decides first with better facts (the harness's process, its last
 * hook). What reaches this limit is a harness whose process stayed alive, or
 * a host that stopped reporting.
 */
export const TACHO_IDLE_CLOSE_AFTER_MS = 12 * 60 * 60 * 1000;
export const TACHO_ENFORCEMENT_TIERS = [
  "contained",
  "gateway",
  "harness",
  "observe",
] as const;
export const TACHO_COMMANDS = [
  "pause",
  "resume",
  "cancel",
  "steer",
  "message",
  "revoke",
  "refresh_bundle",
  "kill",
] as const;
/**
 * The closed command-status vocabulary of the Mission Control spec §7.4,
 * shared by commands and messages. `applied` is the only success status;
 * `cancelled`, `expired` and `failed` are the three undelivered endings.
 */
export const TACHO_COMMAND_OUTCOMES = [
  "draft",
  "queued",
  "sent",
  "received",
  "acknowledged",
  "applied",
  "cancelled",
  "expired",
  "failed",
] as const;
/** The statuses a command cannot leave. */
export const TACHO_COMMAND_TERMINAL_OUTCOMES = [
  "applied",
  "cancelled",
  "expired",
  "failed",
] as const;
/**
 * What a command row is addressed to: the host that carries it, or the run
 * it steers. A broadcast (`@agents`, `@<agent>`) is resolved to one row per
 * recipient run at dispatch, so no row is addressed to an agent or a
 * workspace; the address travels in `payload.address`.
 */
export const TACHO_COMMAND_TARGET_KINDS = ["host", "run"] as const;
/** Spec §7.3 delivery modes: which model request a steer rides. */
export const TACHO_DELIVERY_MODES = [
  "next_step",
  "interrupt",
  "turn_boundary",
] as const;
export const TACHO_INCIDENT_KINDS = [
  "unobserved_session",
  "hooks_removed",
  "config_change",
  "telemetry_gap",
  "chain_break",
  "checkpoint_lapse",
  "token_replay",
  "policy_violation",
  "spoofed_event",
  "daemon_down",
  "otel_missing",
  "unknown_model_cost",
] as const;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

// ── hosts ────────────────────────────────────────────────────────────────────
// One row per enrolled machine (data-model 3.1). The API key that carries the
// host's scope lives in auth.api_keys; api_key_id is the app-enforced link.
export const tachoHosts = tachoSchema.table(
  "hosts",
  {
    ...idMixin("tch"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // Identity
    agentKey: text("agent_key").notNull(),
    agentId: uuid("agent_id"),
    agentPrincipalId: uuid("agent_principal_id"),
    apiKeyId: uuid("api_key_id").notNull(),
    // Host facts (the readable forms live here under RLS; ClickHouse gets digests)
    hostname: text("hostname").notNull(),
    hostnameDigest: text("hostname_digest").notNull(),
    platform: text("platform").notNull(),
    osVersion: text("os_version"),
    arch: text("arch"),
    osUser: text("os_user").notNull(),
    osUserDigest: text("os_user_digest").notNull(),
    devicePublicKey: text("device_public_key").notNull(),
    deviceKeyFingerprint: text("device_key_fingerprint").notNull(),
    harnesses: jsonb("harnesses").notNull().default(sql`'[]'::jsonb`),
    claudeVersionAtEnroll: text("claude_version_at_enroll"),
    claudeExecpath: text("claude_execpath"),
    nodeVersion: text("node_version"),
    wrapperVersion: text("wrapper_version"),
    shell: text("shell"),
    terminalTypeLast: text("terminal_type_last"),
    // Enrollment
    status: text("status").notNull().default("active"),
    enrollmentClaims: jsonb("enrollment_claims").notNull(),
    enrollmentSignature: text("enrollment_signature").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokeReason: text("revoke_reason"),
    managed: boolean("managed").notNull().default(false),
    managedSettingsDigest: text("managed_settings_digest"),
    userSettingsDigest: text("user_settings_digest"),
    projectSettingsDigests: jsonb("project_settings_digests")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Policy
    mode: text("mode").notNull().default("observe"),
    bundleVersionServed: integer("bundle_version_served"),
    bundleEtagServed: text("bundle_etag_served"),
    denyGenerationOrgSeen: bigint("deny_generation_org_seen", {
      mode: "number",
    }),
    denyGenerationWsSeen: bigint("deny_generation_ws_seen", { mode: "number" }),
    lastBundleFetchAt: ts("last_bundle_fetch_at"),
    // Liveness
    lastSeenAt: ts("last_seen_at"),
    lastIngestAt: ts("last_ingest_at"),
    lastHeartbeatAt: ts("last_heartbeat_at"),
    /**
     * When the control plane last AUTHORISED a call presenting this host's
     * `tacho_gateway_v1` key — a server observation, not a client claim.
     *
     * The enforcement tier exists to separate what the platform enforced from
     * what the agent says it did, so it may not be read off a submitted
     * record. A harness holds the local bearer and OTLP attributes pass
     * through the normalizer verbatim, so anything the daemon seals is
     * attested by the client; the seal proves the record was not altered after
     * collection, never that the value was true going in.
     *
     * This column is the other thing: written where the gateway key is
     * authenticated, from a request the control plane served itself. Ingest
     * derives the `gateway` tier from it rather than from the batch.
     */
    gatewayLastSeenAt: ts("gateway_last_seen_at"),
    spoolDepth: integer("spool_depth").notNull().default(0),
    spoolOldestAt: ts("spool_oldest_at"),
    hooksOk: boolean("hooks_ok"),
    hooksLastCheckedAt: ts("hooks_last_checked_at"),
    otelOk: boolean("otel_ok"),
    daemonVersion: text("daemon_version"),
    daemonUptimeS: integer("daemon_uptime_s"),
    /**
     * The bundle fields this host told us it can parse
     * (`TACHO_BUNDLE_FEATURES` in `@oxagen/tacho`). Written at enrollment and
     * refreshed from the daemon's health report on every control poll, so it
     * tracks the code the host is *running* rather than the code it enrolled
     * with — `wrapper_version` and `daemon_version` both come from
     * `host.json`, which `enroll` writes once and no upgrade rewrites.
     *
     * Empty is the honest default for every row that predates this column:
     * those hosts never advertised anything, and a gated bundle field must
     * not be sent to a parser that would reject the whole mandate over it.
     */
    bundleFeatures: jsonb("bundle_features")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<string[]>(),
    /**
     * What the daemon reports about the model base URL it wrote into each
     * harness config file: one entry per harness with the file's key, whether
     * the value still points at the loopback proxy, and the managed settings
     * file shadowing it when one does.
     *
     * A laptop user who edits `env.ANTHROPIC_BASE_URL` or `openai_base_url`
     * back to the vendor leaves the gateway with one file edit and no restart.
     * Before this column the control plane saw only the effect — sessions
     * stopped reaching the `gateway` tier — and had to guess the cause from a
     * symptom that a machine merely being offline produces too. The daemon
     * already computes the answer for `tacho status`; this is the same answer
     * on the health report.
     *
     * Empty is the honest default for a row that predates the column and for a
     * daemon too old to report one: absent means *nothing was said*, never
     * *nothing has drifted*.
     */
    modelBaseUrls: jsonb("model_base_urls")
      .notNull()
      .default(sql`'[]'::jsonb`)
      .$type<
        {
          harness: string;
          key: string;
          ours: boolean;
          shadowed_by?: string;
        }[]
      >(),
    // Counters
    sessionsCount: integer("sessions_count").notNull().default(0),
    unobservedSessionsCount: integer("unobserved_sessions_count")
      .notNull()
      .default(0),
    incidentsOpen: integer("incidents_open").notNull().default(0),
  },
  (t) => ({
    orgIdx: index("tacho_hosts_org_idx").on(t.orgId, t.workspaceId),
    apiKeyUniq: uniqueIndex("tacho_hosts_api_key_uniq").on(t.apiKeyId),
    // One live host per agent key; a revoked host gives its key up.
    agentKeyUniq: uniqueIndex("tacho_hosts_agent_key_uniq")
      .on(t.orgId, t.agentKey)
      .where(sql`${t.status} <> 'revoked'`),
    statusCheck: check(
      "tacho_hosts_status_check",
      sql`${t.status} IN (${sql.raw(inList(TACHO_HOST_STATUSES))})`,
    ),
    modeCheck: check(
      "tacho_hosts_mode_check",
      sql`${t.mode} IN (${sql.raw(inList(TACHO_HOST_MODES))})`,
    ),
    platformCheck: check(
      "tacho_hosts_platform_check",
      sql`${t.platform} IN ('darwin', 'linux', 'win32')`,
    ),
    revokedCheck: check(
      "tacho_hosts_revoked_check",
      sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`,
    ),
  }),
);

// ── sessions ─────────────────────────────────────────────────────────────────
// One row per chain (a subagent is its own row, linked by parent_session_id).
// Wide on purpose: this is the flight-recorder index (data-model 3.2).
export const tachoSessions = tachoSchema.table(
  "sessions",
  {
    ...idMixin("tse"),
    ...auditMixin(),
    ...orgScopeMixin(),
    // Identity
    sessionUuid: uuid("session_uuid").notNull(),
    harnessSessionId: text("harness_session_id").notNull(),
    hostId: uuid("host_id"),
    agentKey: text("agent_key").notNull(),
    agentId: uuid("agent_id"),
    agentPrincipalId: uuid("agent_principal_id"),
    initiatingPrincipalId: uuid("initiating_principal_id"),
    initiatingUserId: uuid("initiating_user_id"),
    rootSessionUuid: uuid("root_session_uuid").notNull(),
    parentSessionUuid: uuid("parent_session_uuid"),
    subagentId: text("subagent_id"),
    subagentType: text("subagent_type"),
    subagentDescription: text("subagent_description"),
    spawnDepth: smallint("spawn_depth").notNull().default(0),
    spawnToolUseId: text("spawn_tool_use_id"),
    // Anthropic-side observations (never used for scoping)
    anthropicUserIdHash: text("anthropic_user_id_hash"),
    anthropicAccountUuid: text("anthropic_account_uuid"),
    anthropicAccountId: text("anthropic_account_id"),
    anthropicOrgUuid: text("anthropic_org_uuid"),
    apiKeySource: text("api_key_source"),
    /** Latest host facts carried by this session, separate from enrollment. */
    machineSnapshot: jsonb("machine_snapshot"),
    // Harness
    runtime: text("runtime").notNull(),
    harness: text("harness").notNull(),
    harnessVersion: text("harness_version"),
    wrapperVersion: text("wrapper_version"),
    entrypoint: text("entrypoint"),
    querySourceInitial: text("query_source_initial"),
    terminalType: text("terminal_type"),
    sessionKind: text("session_kind"),
    isChildSession: boolean("is_child_session"),
    bridgeSessionId: text("bridge_session_id"),
    outputStyle: text("output_style"),
    effort: text("effort"),
    modelInitial: text("model_initial"),
    modelFinal: text("model_final"),
    fastModeState: text("fast_mode_state"),
    fastModeDisabledReason: text("fast_mode_disabled_reason"),
    permissionModeInitial: text("permission_mode_initial"),
    permissionModeFinal: text("permission_mode_final"),
    permissionModeChanges: bigint("permission_mode_changes", { mode: "number" })
      .notNull()
      .default(0),
    analyticsDisabled: boolean("analytics_disabled"),
    // Lifecycle
    startType: text("start_type"),
    startSource: text("start_source"),
    endReason: text("end_reason"),
    terminalReason: text("terminal_reason"),
    stopReasonFinal: text("stop_reason_final"),
    outcome: text("outcome").notNull().default("running"),
    isError: boolean("is_error"),
    apiErrorStatus: integer("api_error_status"),
    startedAt: ts("started_at").notNull(),
    firstPromptAt: ts("first_prompt_at"),
    lastEventAt: ts("last_event_at").notNull(),
    endedAt: ts("ended_at"),
    sealedAt: ts("sealed_at"),
    /** Who sealed it: see `TACHO_SEAL_SOURCES`. */
    sealSource: text("seal_source"),
    // Place
    cwd: text("cwd"),
    projectDir: text("project_dir"),
    transcriptPath: text("transcript_path"),
    gitRemoteDigest: text("git_remote_digest"),
    gitBranch: text("git_branch"),
    gitHeadShaStart: text("git_head_sha_start"),
    gitHeadShaEnd: text("git_head_sha_end"),
    gitDirtyStart: boolean("git_dirty_start"),
    worktreePath: text("worktree_path"),
    worktreeName: text("worktree_name"),
    worktreeBranch: text("worktree_branch"),
    relocatedCwd: text("relocated_cwd"),
    // Inventory (jsonb, shapes documented in data-model 3.2)
    toolsAvailable: jsonb("tools_available"),
    mcpServers: jsonb("mcp_servers"),
    agentsAvailable: jsonb("agents_available"),
    skillsAvailable: jsonb("skills_available"),
    slashCommands: jsonb("slash_commands"),
    plugins: jsonb("plugins"),
    pluginErrors: jsonb("plugin_errors"),
    mcpServerErrors: jsonb("mcp_server_errors"),
    harnessCapabilities: jsonb("harness_capabilities"),
    instructionsLoaded: jsonb("instructions_loaded"),
    settingsSources: jsonb("settings_sources"),
    hooksRegistered: jsonb("hooks_registered"),
    envSnapshot: jsonb("env_snapshot"),
    memoryPaths: jsonb("memory_paths"),
    availableModels: jsonb("available_models"),
    fallbackModels: jsonb("fallback_models"),
    effortLevelSetting: text("effort_level_setting"),
    sandboxEnabled: boolean("sandbox_enabled"),
    autoCompactEnabled: boolean("auto_compact_enabled"),
    alwaysThinkingEnabled: boolean("always_thinking_enabled"),
    promptCacheTtl: text("prompt_cache_ttl"),
    defaultPermissionModeSetting: text("default_permission_mode_setting"),
    // Totals
    numTurns: bigint("num_turns", { mode: "number" }).notNull().default(0),
    numPrompts: bigint("num_prompts", { mode: "number" }).notNull().default(0),
    numModelCalls: bigint("num_model_calls", { mode: "number" })
      .notNull()
      .default(0),
    numApiErrors: bigint("num_api_errors", { mode: "number" })
      .notNull()
      .default(0),
    numApiRetries: bigint("num_api_retries", { mode: "number" })
      .notNull()
      .default(0),
    numToolCalls: bigint("num_tool_calls", { mode: "number" })
      .notNull()
      .default(0),
    numToolErrors: bigint("num_tool_errors", { mode: "number" })
      .notNull()
      .default(0),
    numToolRejections: bigint("num_tool_rejections", { mode: "number" })
      .notNull()
      .default(0),
    numToolAsks: bigint("num_tool_asks", { mode: "number" })
      .notNull()
      .default(0),
    numSubagents: bigint("num_subagents", { mode: "number" })
      .notNull()
      .default(0),
    numCompactions: bigint("num_compactions", { mode: "number" })
      .notNull()
      .default(0),
    numModelSwitches: bigint("num_model_switches", { mode: "number" })
      .notNull()
      .default(0),
    numNotifications: bigint("num_notifications", { mode: "number" })
      .notNull()
      .default(0),
    numElicitations: bigint("num_elicitations", { mode: "number" })
      .notNull()
      .default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheCreation5mTokens: bigint("cache_creation_5m_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    cacheCreation1hTokens: bigint("cache_creation_1h_tokens", {
      mode: "number",
    })
      .notNull()
      .default(0),
    thinkingTokens: bigint("thinking_tokens", { mode: "number" })
      .notNull()
      .default(0),
    webSearchRequests: bigint("web_search_requests", { mode: "number" })
      .notNull()
      .default(0),
    webFetchRequests: bigint("web_fetch_requests", { mode: "number" })
      .notNull()
      .default(0),
    totalCostMicros: bigint("total_cost_micros", { mode: "number" })
      .notNull()
      .default(0),
    costBasis: text("cost_basis"),
    hasUnknownModelCost: boolean("has_unknown_model_cost"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    apiDurationMs: bigint("api_duration_ms", { mode: "number" }),
    apiDurationWithoutRetriesMs: bigint("api_duration_without_retries_ms", {
      mode: "number",
    }),
    toolDurationMs: bigint("tool_duration_ms", { mode: "number" }),
    activeTimeS: bigint("active_time_s", { mode: "number" }),
    ttftFirstMs: bigint("ttft_first_ms", { mode: "number" }),
    linesAdded: bigint("lines_added", { mode: "number" }).notNull().default(0),
    linesRemoved: bigint("lines_removed", { mode: "number" })
      .notNull()
      .default(0),
    filesRead: bigint("files_read", { mode: "number" }).notNull().default(0),
    filesWritten: bigint("files_written", { mode: "number" })
      .notNull()
      .default(0),
    filesDeleted: bigint("files_deleted", { mode: "number" })
      .notNull()
      .default(0),
    commandsRun: bigint("commands_run", { mode: "number" })
      .notNull()
      .default(0),
    networkCalls: bigint("network_calls", { mode: "number" })
      .notNull()
      .default(0),
    commits: bigint("commits", { mode: "number" }).notNull().default(0),
    pushes: bigint("pushes", { mode: "number" }).notNull().default(0),
    pullRequests: bigint("pull_requests", { mode: "number" })
      .notNull()
      .default(0),
    subagentStats: jsonb("subagent_stats"),
    permissionDenials: jsonb("permission_denials"),
    modelsUsed: jsonb("models_used"),
    // Policy
    /**
     * Derived by `tacho.events.ingest` from the control plane's own records —
     * the host's mode, and `tacho_hosts.gateway_last_seen_at` for `gateway`.
     * Never read off a submitted batch: the tier's whole value is that it
     * separates what the platform enforced from what the agent claims, and a
     * tier the agent can set is the absence of that, with a seal over it.
     */
    enforcementTier: text("enforcement_tier").notNull().default("observe"),
    /**
     * The gateway observation this row's `gateway` tier stands on: the host's
     * `gateway_last_seen_at` as it read when the tier was set. Null on every
     * other tier.
     *
     * A tier may rise after the fact — a daemon chain opens before the first
     * connected app calls anything — so a risen tier has to be answerable for
     * itself. This column is that answer, and its absence on a `gateway` row
     * is a defect, not a blank.
     */
    gatewayObservedAt: ts("gateway_observed_at"),
    bundleMode: text("bundle_mode"),
    bundleVersion: integer("bundle_version"),
    policyDecisions: bigint("policy_decisions", { mode: "number" })
      .notNull()
      .default(0),
    policyDenies: bigint("policy_denies", { mode: "number" })
      .notNull()
      .default(0),
    elevationsRequested: bigint("elevations_requested", { mode: "number" })
      .notNull()
      .default(0),
    elevationsApproved: bigint("elevations_approved", { mode: "number" })
      .notNull()
      .default(0),
    elevationsDenied: bigint("elevations_denied", { mode: "number" })
      .notNull()
      .default(0),
    elevationsExpired: bigint("elevations_expired", { mode: "number" })
      .notNull()
      .default(0),
    tokensIssued: bigint("tokens_issued", { mode: "number" })
      .notNull()
      .default(0),
    tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
    // Chain
    seqCount: bigint("seq_count", { mode: "number" }).notNull().default(0),
    genesisHash: text("genesis_hash"),
    lastHash: text("last_hash"),
    finalHash: text("final_hash"),
    checkpointCount: bigint("checkpoint_count", { mode: "number" })
      .notNull()
      .default(0),
    lastCheckpointId: uuid("last_checkpoint_id"),
    chainVerified: boolean("chain_verified").notNull().default(true),
    chainBreakAtSeq: bigint("chain_break_at_seq", { mode: "number" }),
    telemetryGapCount: bigint("telemetry_gap_count", { mode: "number" })
      .notNull()
      .default(0),
    unobservedTail: boolean("unobserved_tail").notNull().default(false),
    completenessGaps: jsonb("completeness_gaps")
      .notNull()
      .default(sql`'[]'::jsonb`),
    replayGrade: text("replay_grade"),
    evidenceManifestId: uuid("evidence_manifest_id"),
    // Frames that carried content (a content-bearing kind, or any kind that
    // chained a digest), how many of those arrived with a body the recorder
    // retained, and how many of the retained bodies belong to a `tool_call`.
    // The seal grades `body_missing` when the second falls short of the
    // first and `tool_bodies` when tool calls happened and the third is zero
    // (ADR-058).
    contentFrames: bigint("content_frames", { mode: "number" })
      .notNull()
      .default(0),
    bodyFrames: bigint("body_frames", { mode: "number" }).notNull().default(0),
    toolBodyFrames: bigint("tool_body_frames", { mode: "number" })
      .notNull()
      .default(0),
    // Presentation
    title: text("title"),
    lastPromptDigest: text("last_prompt_digest"),
    // Generated by `summarize_run`, the three summary columns set together;
    // labelled generated wherever it renders (ADR-058, G14).
    name: text("name"),
    summary: text("summary"),
    summaryGeneratedAt: timestamp("summary_generated_at", {
      withTimezone: true,
      mode: "date",
    }),
    summaryModel: text("summary_model"),
    summaryInputDigest: text("summary_input_digest"),
    summaryObservedAt: timestamp("summary_observed_at", {
      withTimezone: true,
      mode: "date",
    }),
    // The row's updated_at as the last enrichment read saw it (ADR-153).
    summaryObservedRevision: timestamp("summary_observed_revision", {
      withTimezone: true,
      mode: "date",
    }),
    // Why the last automatic account failed, as a short reason code; null
    // once an account is written or the run is no longer due.
    summaryError: text("summary_error"),
    // The title the harness gave the session itself (Claude Code's
    // `ai-title`), and the frame time it carried. It outranks `name` and
    // `title` on the Run page, and an older frame never replaces it.
    harnessTitle: text("harness_title"),
    harnessTitleAt: timestamp("harness_title_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => ({
    sessionUuidUniq: uniqueIndex("tacho_sessions_session_uuid_uniq").on(
      t.sessionUuid,
    ),
    orgIdx: index("tacho_sessions_org_idx").on(
      t.orgId,
      t.workspaceId,
      t.startedAt,
    ),
    hostIdx: index("tacho_sessions_host_idx").on(t.hostId, t.startedAt),
    rootIdx: index("tacho_sessions_root_idx").on(t.rootSessionUuid),
    replayGradeCheck: check(
      "tacho_sessions_replay_grade_check",
      sql`${t.replayGrade} IS NULL OR ${t.replayGrade} IN ('inspect', 'view', 'fork', 'retry')`,
    ),
    bodyFramesCheck: check(
      "tacho_sessions_body_frames_check",
      sql`${t.contentFrames} >= 0 AND ${t.bodyFrames} >= 0 AND ${t.bodyFrames} <= ${t.contentFrames} AND ${t.toolBodyFrames} >= 0 AND ${t.toolBodyFrames} <= ${t.bodyFrames}`,
    ),
    summaryCheck: check(
      "tacho_sessions_summary_check",
      sql`(${t.summary} IS NULL) = (${t.summaryGeneratedAt} IS NULL) AND (${t.summary} IS NULL) = (${t.summaryModel} IS NULL)`,
    ),
    outcomeCheck: check(
      "tacho_sessions_outcome_check",
      sql`${t.outcome} IN (${sql.raw(inList(TACHO_SESSION_OUTCOMES))})`,
    ),
    runtimeCheck: check(
      "tacho_sessions_runtime_check",
      sql`${t.runtime} IN (${sql.raw(inList(TACHO_RUNTIMES))})`,
    ),
    tierCheck: check(
      "tacho_sessions_tier_check",
      sql`${t.enforcementTier} IN (${sql.raw(inList(TACHO_ENFORCEMENT_TIERS))})`,
    ),
    sealSourceCheck: check(
      "tacho_sessions_seal_source_check",
      sql`${t.sealSource} IS NULL OR ${t.sealSource} IN (${sql.raw(inList(TACHO_SEAL_SOURCES))})`,
    ),
    openLastEventIdx: index("tacho_sessions_open_last_event_idx")
      .on(t.lastEventAt)
      .where(sql`${t.sealedAt} IS NULL`),
    hashCheck: check(
      "tacho_sessions_hash_check",
      sql`(${t.lastHash} IS NULL OR ${t.lastHash} ~ '^sha256:[0-9a-f]{64}$') AND (${t.finalHash} IS NULL OR ${t.finalHash} ~ '^sha256:[0-9a-f]{64}$')`,
    ),
  }),
);

// ── session_models ───────────────────────────────────────────────────────────
export const tachoSessionModels = tachoSchema.table(
  "session_models",
  {
    ...idMixin("tsm"),
    ...auditMixin(),
    ...orgScopeMixin(),
    sessionId: uuid("session_id").notNull(),
    model: text("model").notNull(),
    canonicalModel: text("canonical_model"),
    provider: text("provider"),
    costBasis: text("cost_basis"),
    contextWindow: integer("context_window"),
    maxOutputTokens: integer("max_output_tokens"),
    requests: bigint("requests", { mode: "number" }).notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" })
      .notNull()
      .default(0),
    thinkingTokens: bigint("thinking_tokens", { mode: "number" })
      .notNull()
      .default(0),
    webSearchRequests: bigint("web_search_requests", { mode: "number" })
      .notNull()
      .default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    apiDurationMs: bigint("api_duration_ms", { mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => ({
    sessionModelUniq: uniqueIndex("tacho_session_models_uniq").on(
      t.sessionId,
      t.model,
    ),
    orgIdx: index("tacho_session_models_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// ── session_files ────────────────────────────────────────────────────────────
// The lineage seam for Neo4j: one row per path a session touched.
export const tachoSessionFiles = tachoSchema.table(
  "session_files",
  {
    ...idMixin("tsf"),
    ...auditMixin(),
    ...orgScopeMixin(),
    sessionId: uuid("session_id").notNull(),
    path: text("path").notNull(),
    repoRelativePath: text("repo_relative_path"),
    language: text("language"),
    reads: integer("reads").notNull().default(0),
    writes: integer("writes").notNull().default(0),
    edits: integer("edits").notNull().default(0),
    deletes: integer("deletes").notNull().default(0),
    bytesWritten: bigint("bytes_written", { mode: "number" })
      .notNull()
      .default(0),
    linesAdded: integer("lines_added").notNull().default(0),
    linesRemoved: integer("lines_removed").notNull().default(0),
    /**
     * What git said about this path at the last reconciliation: added,
     * modified, deleted or renamed. Null means no current changed-file
     * observation, including a later complete snapshot that cleared it. The counters above
     * count tool calls; this states a condition, so it is assigned and never
     * incremented.
     */
    observedStatus: text("observed_status"),
    firstSeq: bigint("first_seq", { mode: "number" }).notNull(),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
    digestBefore: text("digest_before"),
    digestAfter: text("digest_after"),
  },
  (t) => ({
    sessionPathUniq: uniqueIndex("tacho_session_files_uniq").on(
      t.sessionId,
      t.path,
    ),
    orgIdx: index("tacho_session_files_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// ── run_pull_requests ────────────────────────────────────────────────────────
// One row per pull request (or GitLab merge request) a root session's record
// names, with the state a forge last reported for it (#4129, ADR-192). Forge
// webhooks keep the state current, and one read when the link lands fills it
// before the first delivery. The link itself stays in the session's frames:
// this row holds only what the frames cannot, the state.
export const tachoRunPullRequests = tachoSchema.table(
  "run_pull_requests",
  {
    ...idMixin("trp"),
    ...auditMixin(),
    ...orgScopeMixin(),
    /** The root `tacho.sessions.id` whose record names the pull request. */
    sessionId: uuid("session_id").notNull(),
    /** The https URL as the frame recorded it. */
    url: text("url").notNull(),
    provider: text("provider").notNull(),
    /**
     * Lower-cased `owner/name`, or the GitLab project path. A match key for
     * webhook deliveries only, never shown.
     */
    repository: text("repository").notNull(),
    /** The pull request number, or the GitLab merge request iid. */
    number: integer("number").notNull(),
    /** `open`, `merged` or `closed`; null until a forge reported one. */
    state: text("state"),
    /** Only an open pull request can be a draft. */
    draft: boolean("draft").notNull().default(false),
    /** When Oxagen last read the state; null when it never has. */
    stateSeenAt: ts("state_seen_at"),
    /**
     * The forge's `updated_at` for the state held here. A delivery older than
     * it never overwrites the row, because forges deliver out of order.
     */
    sourceUpdatedAt: ts("source_updated_at"),
  },
  (t) => ({
    sessionUrlUniq: uniqueIndex("tacho_run_pull_requests_uniq").on(
      t.sessionId,
      t.url,
    ),
    // The webhook lookup: every row one delivery updates.
    forgeIdx: index("tacho_run_pull_requests_forge_idx").on(
      t.orgId,
      t.provider,
      t.repository,
      t.number,
    ),
    orgIdx: index("tacho_run_pull_requests_org_idx").on(t.orgId, t.workspaceId),
    providerCheck: check(
      "tacho_run_pull_requests_provider_check",
      sql`${t.provider} IN ('github', 'gitlab')`,
    ),
    stateCheck: check(
      "tacho_run_pull_requests_state_check",
      sql`${t.state} IS NULL OR ${t.state} IN ('open', 'merged', 'closed')`,
    ),
    numberCheck: check(
      "tacho_run_pull_requests_number_check",
      sql`${t.number} > 0`,
    ),
    draftCheck: check(
      "tacho_run_pull_requests_draft_check",
      sql`NOT ${t.draft} OR ${t.state} IS NULL OR ${t.state} = 'open'`,
    ),
  }),
);

// ── session_commands ─────────────────────────────────────────────────────────
// One row per shell command a session ran (data-model 3.5).
export const tachoSessionCommands = tachoSchema.table(
  "session_commands",
  {
    ...idMixin("tsc"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    sessionId: uuid("session_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    toolUseId: text("tool_use_id"),
    commandDigest: text("command_digest").notNull(),
    commandHead: text("command_head").notNull(),
    bashCommand: text("bash_command"),
    exitStatus: integer("exit_status"),
    durationMs: bigint("duration_ms", { mode: "number" }),
    status: text("status"),
    cwd: text("cwd"),
    decision: text("decision"),
    decisionSource: text("decision_source"),
    policyRule: text("policy_rule"),
  },
  (t) => ({
    sessionSeqUniq: uniqueIndex("tacho_session_commands_uniq").on(
      t.sessionId,
      t.seq,
    ),
    orgIdx: index("tacho_session_commands_org_idx").on(t.orgId, t.workspaceId),
  }),
);

// ── control_commands ─────────────────────────────────────────────────────────
// Oxagen -> agent commands (data-model 3.6, spec section 7.4; Mission Control
// spec §7.3, §7.4 and Appendix A.6). One row per recipient: a host, or one
// run. `outcome` carries the §7.4 status vocabulary; `requested_mode` and
// `delivery_mode` are recorded separately so a report shows the mode that
// was achieved, never the one that was asked for.
export const tachoControlCommands = tachoSchema.table(
  "control_commands",
  {
    ...idMixin("tcm"),
    ...auditMixin(),
    ...orgScopeMixin(),
    /** The host that carries the command; null for a run with no host. */
    hostId: uuid("host_id"),
    sessionId: uuid("session_id"),
    targetKind: text("target_kind").notNull(),
    /** The recipient's public id: `tch_…` for a host, `tse_…`/`arun_…` for a run. */
    targetId: text("target_id").notNull(),
    command: text("command").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    requestedMode: text("requested_mode"),
    deliveryMode: text("delivery_mode"),
    degradedReason: text("degraded_reason"),
    reason: text("reason"),
    issuedByPrincipalId: uuid("issued_by_principal_id"),
    issuedByUserId: uuid("issued_by_user_id"),
    issuedAt: ts("issued_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    deliveredAt: ts("delivered_at"),
    acknowledgedAt: ts("acknowledged_at"),
    appliedAt: ts("applied_at"),
    appliedAtSeq: bigint("applied_at_seq", { mode: "number" }),
    outcome: text("outcome").notNull().default("queued"),
    outcomeDetail: text("outcome_detail"),
  },
  (t) => ({
    hostPendingIdx: index("tacho_control_commands_host_pending_idx").on(
      t.hostId,
      t.outcome,
      t.issuedAt,
    ),
    orgIdx: index("tacho_control_commands_org_idx").on(t.orgId, t.workspaceId),
    targetIdx: index("tacho_control_commands_target_idx").on(
      t.orgId,
      t.workspaceId,
      t.targetKind,
      t.targetId,
      t.issuedAt,
    ),
    commandCheck: check(
      "tacho_control_commands_command_check",
      sql`${t.command} IN (${sql.raw(inList(TACHO_COMMANDS))})`,
    ),
    outcomeCheck: check(
      "tacho_control_commands_outcome_check",
      sql`${t.outcome} IN (${sql.raw(inList(TACHO_COMMAND_OUTCOMES))})`,
    ),
    targetKindCheck: check(
      "tacho_control_commands_target_kind_check",
      sql`${t.targetKind} IN (${sql.raw(inList(TACHO_COMMAND_TARGET_KINDS))})`,
    ),
    requestedModeCheck: check(
      "tacho_control_commands_requested_mode_check",
      sql`${t.requestedMode} IS NULL OR ${t.requestedMode} IN (${sql.raw(inList(TACHO_DELIVERY_MODES))})`,
    ),
    deliveryModeCheck: check(
      "tacho_control_commands_delivery_mode_check",
      sql`${t.deliveryMode} IS NULL OR ${t.deliveryMode} IN (${sql.raw(inList(TACHO_DELIVERY_MODES))})`,
    ),
  }),
);

// ── incidents ────────────────────────────────────────────────────────────────
export const tachoIncidents = tachoSchema.table(
  "incidents",
  {
    ...idMixin("tin"),
    ...auditMixin(),
    ...orgScopeMixin(),
    hostId: uuid("host_id"),
    sessionId: uuid("session_id"),
    kind: text("kind").notNull(),
    severity: smallint("severity").notNull(),
    detectedAt: ts("detected_at").notNull().defaultNow(),
    detectedBy: text("detected_by").notNull(),
    evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
    eventSeq: bigint("event_seq", { mode: "number" }),
    resolvedAt: ts("resolved_at"),
    resolvedByPrincipalId: uuid("resolved_by_principal_id"),
    resolutionNote: text("resolution_note"),
    trustWeight: integer("trust_weight"),
  },
  (t) => ({
    hostOpenIdx: index("tacho_incidents_host_open_idx").on(
      t.hostId,
      t.resolvedAt,
    ),
    orgIdx: index("tacho_incidents_org_idx").on(
      t.orgId,
      t.workspaceId,
      t.detectedAt,
    ),
    kindCheck: check(
      "tacho_incidents_kind_check",
      sql`${t.kind} IN (${sql.raw(inList(TACHO_INCIDENT_KINDS))})`,
    ),
    severityCheck: check(
      "tacho_incidents_severity_check",
      sql`${t.severity} IN (1, 3, 10)`,
    ),
    detectedByCheck: check(
      "tacho_incidents_detected_by_check",
      sql`${t.detectedBy} IN ('collector', 'control_plane', 'human')`,
    ),
  }),
);

// ── checkpoints ──────────────────────────────────────────────────────────────
// Signed chain commitments (design/trace-model.md section 2). Append-only.
export const tachoCheckpoints = tachoSchema.table(
  "checkpoints",
  {
    ...idMixin("tck"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    sessionId: uuid("session_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    chainHead: text("chain_head").notNull(),
    eventCount: bigint("event_count", { mode: "number" }).notNull(),
    deviceKeyFingerprint: text("device_key_fingerprint").notNull(),
    deviceSignature: text("device_signature").notNull(),
    platformKeyId: text("platform_key_id"),
    platformSignature: text("platform_signature"),
    signedAt: ts("signed_at").notNull(),
    countersignedAt: ts("countersigned_at"),
    anchorRoot: text("anchor_root"),
    anchoredAt: ts("anchored_at"),
  },
  (t) => ({
    sessionSeqUniq: uniqueIndex("tacho_checkpoints_uniq").on(
      t.sessionId,
      t.seq,
    ),
    orgIdx: index("tacho_checkpoints_org_idx").on(t.orgId, t.workspaceId),
    headCheck: check(
      "tacho_checkpoints_head_check",
      sql`${t.chainHead} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  }),
);

// ── enrollment_tokens ────────────────────────────────────────────────────────
// The single-use enrollment token (#2967, spec §7.2 "a one-time enrollment
// token embedded"): minted by create_enrollment_token for one registered
// agent, shown to the operator once, stored as a SHA-256 digest, and consumed
// by enroll_host exactly once — the claim is `UPDATE … SET used_at = now()
// WHERE used_at IS NULL`, so two hosts presenting the same token cannot both
// enrol. A presentation that is refused (used, expired) increments
// rejected_count so the installer's "token rejected" screen can say so.
export const tachoEnrollmentTokens = tachoSchema.table(
  "enrollment_tokens",
  {
    ...idMixin("tet"),
    ...appendOnlyAuditMixin(),
    ...orgScopeMixin(),
    // The agent.agents row the token enrols a host for. App-enforced.
    agentId: uuid("agent_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    // The operator the token was issued to: the registering user.
    issuedToUserId: uuid("issued_to_user_id").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    usedByHostId: uuid("used_by_host_id"),
    rejectedCount: integer("rejected_count").notNull().default(0),
  },
  (t) => ({
    tokenHashUniq: uniqueIndex("tacho_enrollment_tokens_hash_uniq").on(
      t.tokenHash,
    ),
    agentIdx: index("tacho_enrollment_tokens_agent_idx").on(
      t.orgId,
      t.workspaceId,
      t.agentId,
    ),
    hashCheck: check(
      "tacho_enrollment_tokens_hash_check",
      sql`${t.tokenHash} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    // A used token names the host that used it, and only a used token does.
    usedCheck: check(
      "tacho_enrollment_tokens_used_check",
      sql`(${t.usedAt} IS NULL) = (${t.usedByHostId} IS NULL)`,
    ),
  }),
);

/**
 * The two columns migration `20260917140000` adds, named the way
 * `information_schema` names them.
 *
 * Defined here, beside the Drizzle declarations they mirror, because three
 * packages need them and each is a different kind of consumer: `@oxagen/iam`
 * writes the host observation, `@oxagen/handlers` reads both and projects them
 * away while they are missing, and their tests assert the probe was asked.
 * A literal spelled at each site would be renamed on one side without breaking
 * a build — it would simply stop matching, and the guard would silently become
 * "always absent", which reads as a working deploy and is a permanent loss of
 * the gateway tier.
 *
 * Note the SQL names: `"tacho"."hosts"`, not `"tacho"."tacho_hosts"`. The
 * `tacho_` prefix is this schema's constraint and index naming convention and
 * how Drizzle spells the binding in TypeScript; it is not part of the table
 * name. The migration that first shipped this column got that wrong.
 */
export const HOST_GATEWAY_COLUMN = {
  schema: "tacho",
  table: "hosts",
  column: "gateway_last_seen_at",
} as const;

/**
 * The daemon's report on whether each harness still points at the proxy.
 *
 * Probed for the reason the gateway column is, and with a wider blast radius
 * than that one: every `tacho.hosts` relational read selects every declared
 * column, and `resolveEnrolledHost` is on the path of ingest, control polls
 * and bundle fetches alike. Naming this column before the migration lands
 * raises 42703 and takes all three down, over a field that only tells an
 * operator why a tier dropped.
 */
export const HOST_MODEL_BASE_URLS_COLUMN = {
  schema: "tacho",
  table: "hosts",
  column: "model_base_urls",
} as const;

/** The session's copy: what a risen `gateway` tier is answerable for. */
export const SESSION_GATEWAY_COLUMN = {
  schema: "tacho",
  table: "sessions",
  column: "gateway_observed_at",
} as const;

/**
 * What the run pushed, counted on the session row.
 *
 * Probed for the same reason the gateway columns are: production applies
 * migrations by hand from the app node while `deploy-node` ships on merge
 * without waiting, so between the two this code is live and the column is
 * not. Naming it in an UPDATE raises 42703 and takes the whole batch with
 * it — and unlike the gateway tier, this one is on the path every batch
 * walks, so the window would stop ingestion outright rather than degrade it.
 */
export const SESSION_PUSHES_COLUMN = {
  schema: "tacho",
  table: "sessions",
  column: "pushes",
} as const;

/** Session-time host facts, omitted until the additive migration is applied. */
export const SESSION_MACHINE_SNAPSHOT_COLUMN = {
  schema: "tacho",
  table: "sessions",
  column: "machine_snapshot",
} as const;

/** What git observed about one path, on the file row. Same window, same rule. */
export const SESSION_FILE_OBSERVED_STATUS_COLUMN = {
  schema: "tacho",
  table: "session_files",
  column: "observed_status",
} as const;

/**
 * Which of a host's daemon chains the control plane has served a gateway call
 * for, and when it last did.
 *
 * ## Why a row rather than a timestamp
 *
 * `hosts.gateway_last_seen_at` records *that* a host served a gateway call. It
 * cannot record *which of the host's sessions* the call belongs to, because it
 * is one value with no session on it. Ingest closed that gap by reading
 * `oxagen.enforcement_tier` off the submitted batch — and whoever can submit a
 * batch chooses that attribute, so a holder of the host's control-plane key
 * could point a real observation at any session it liked, including one it had
 * just invented (#3221).
 *
 * This table is the correlation, written where the platform knows rather than
 * where it is told. `machineKeyDenial` authenticates a server-minted, per-host
 * `tacho_gateway_v1` credential, reads the daemon's own chain id off the
 * request, and files the two together. A batch submitter cannot cause a row
 * here: it would need the gateway credential, which never leaves the daemon.
 *
 * ## One row per chain, not per call
 *
 * Bounded correlation state, which is what Postgres is for. A row per
 * authorised call would be an append-only audit stream growing with gateway
 * traffic forever inside the transactional database — what AGENTS.md's storage
 * table assigns to ClickHouse and names as a thing Postgres is never for.
 *
 * Nothing is lost by collapsing it. The per-call history already exists in
 * ClickHouse, and it is richer than a row here would be:
 * `recordGatewayCall` seals a `tool_call` or `policy_decision` event carrying
 * the tool, the connected app and the outcome onto the very chain this row
 * names, and ingest writes those through `insertTachoEvents`. The only
 * question Postgres must answer inside a transaction is the one ingest asks —
 * has this host's gateway served this chain, and how recently.
 *
 * `lastSeenAt` rather than the first: a chain that has served gateway calls for
 * a week should not be judged on the one it opened with. A refused call
 * advances it too, because a call Oxagen stopped is evidence that Oxagen was
 * enforcing, not evidence that it was not.
 *
 * ## What the chain id is, and is not
 *
 * `chain_session_uuid` is named by the caller — but by a caller holding the
 * gateway credential, which is the credential whose use is the thing being
 * attested. That is the whole distinction #3221 turns on: the value is not
 * trusted because it was sent, it is trusted because of *who* the control
 * plane authenticated when it arrived. Ingest never reads a session id out of
 * a batch; it asks this table which chains this host's gateway actually
 * served.
 *
 * `chainGenesisHash` is what makes `chainSessionUuid` evidence rather than a
 * claim; ingest requires the session's own recorded `genesisHash` to equal it.
 *
 * It is deliberately NOT a foreign key to `tacho.sessions`. The daemon's chain
 * is created locally and reaches the control plane only when its first batch
 * is flushed, which is routinely after the gateway call that named it — so a
 * row here regularly precedes the session it refers to, and the join happens
 * at read time.
 *
 * Nothing deletes a row, and ingest does NOT consume one on match. Consuming
 * would let a forged batch that arrived first burn a real record belonging to
 * the session that earned it, which trades this defect for a worse one.
 */
export const tachoGatewayChains = tachoSchema.table(
  "gateway_chains",
  {
    ...idMixin("tgc"),
    ...orgScopeMixin(),
    /** The host whose gateway credential was authenticated. App-enforced FK. */
    hostId: uuid("host_id").notNull(),
    /**
     * The daemon chain the gateway was serving, as the daemon named it on the
     * request: `hostRecorder.sessionUuid`, the v5 uuid derived from the host
     * enrollment id and the daemon's `tachod-<ulid>` boot id
     * (`packages/tacho/src/ids.ts`). It is the value ingest matches against
     * `tacho.sessions.session_uuid`, which is a `uuid` column.
     *
     * Text rather than uuid here all the same, and not because the value is
     * anything but a uuid. It arrives on a request header, and this row is
     * written inside `machineKeyDenial` — the authorisation path, which must
     * take a note without ever failing the call it was only observing. A `uuid`
     * column would turn a malformed header into 22P02 and abort that
     * transaction; `text` turns it into a row that matches no session, which is
     * the same outcome as no row at all.
     */
    chainSessionUuid: text("chain_session_uuid").notNull(),
    /**
     * The hash of that chain's first sealed event, as the gateway stated it.
     *
     * What makes the name above evidence. A forger holding the host's ingest
     * key can write the same chain id — open the session first with a chain of
     * its own and let a genuine gateway call advance `lastSeenAt` — but not the
     * same genesis hash, because its chain begins with a different event.
     *
     * Nullable, for a daemon too old to send it. Ingest then refuses to promote
     * rather than promoting on the name alone.
     */
    chainGenesisHash: text("chain_genesis_hash"),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    /** What ingest reads. Moved forward by every served call, refusals too. */
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  },
  (t) => ({
    // The upsert target AND the read ingest makes. One index serves both
    // because there is one row per (host, chain) — the bound stated as a
    // constraint rather than as an intention.
    hostChainUniq: uniqueIndex("tacho_gateway_chains_host_chain_uniq").on(
      t.hostId,
      t.chainSessionUuid,
    ),
  }),
);

/**
 * A column of {@link tachoGatewayChains}, for the deploy-before-migrate probe.
 *
 * One ref answers for the whole table: `information_schema.columns` has no row
 * for a column of a table that does not exist, so a probe for this reads
 * `false` both while the migration is pending and while only half of it ran.
 * That matters more here than for a plain added column — querying an absent
 * TABLE raises 42P01, which aborts the transaction exactly as 42703 does, and
 * would turn a pending migration into failed ingestion for every host.
 */
export const GATEWAY_CHAIN_COLUMN = {
  schema: "tacho",
  table: "gateway_chains",
  column: "chain_session_uuid",
} as const;

/** Trusted launcher receipt. One immutable association per host and session. */
export const tachoContainedLaunches = tachoSchema.table(
  "contained_launches",
  {
    ...idMixin("tcl"),
    ...orgScopeMixin(),
    hostId: uuid("host_id").notNull(),
    sessionUuid: uuid("session_uuid").notNull(),
    genesisHash: text("genesis_hash").notNull(),
    measurement: jsonb("measurement")
      .$type<Record<string, unknown>>()
      .notNull(),
    registeredAt: ts("registered_at").notNull().defaultNow(),
  },
  (t) => ({
    hostSessionUniq: uniqueIndex(
      "tacho_contained_launches_host_session_uniq",
    ).on(t.hostId, t.sessionUuid),
  }),
);

export const CONTAINED_LAUNCH_COLUMN = {
  schema: "tacho",
  table: "contained_launches",
  column: "genesis_hash",
} as const;
