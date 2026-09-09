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
 *     tsf_ session files, tsc_ session commands, tcm_ control commands,
 *     tin_ incidents, tck_ checkpoints.
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
export const TACHO_RUNTIMES = [
  "claude-code",
  "claude-agent-sdk",
  "custom",
  "stella",
  "proxy",
] as const;
export const TACHO_SESSION_OUTCOMES = [
  "running",
  "completed",
  "aborted",
  "crashed",
  "unknown",
] as const;
export const TACHO_ENFORCEMENT_TIERS = [
  "gateway",
  "harness",
  "observe",
] as const;
export const TACHO_COMMANDS = [
  "pause",
  "resume",
  "cancel",
  "message",
  "revoke",
  "refresh_bundle",
  "kill",
] as const;
export const TACHO_COMMAND_OUTCOMES = [
  "pending",
  "delivered",
  "applied",
  "expired",
  "failed",
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
    spoolDepth: integer("spool_depth").notNull().default(0),
    spoolOldestAt: ts("spool_oldest_at"),
    hooksOk: boolean("hooks_ok"),
    hooksLastCheckedAt: ts("hooks_last_checked_at"),
    otelOk: boolean("otel_ok"),
    daemonVersion: text("daemon_version"),
    daemonUptimeS: integer("daemon_uptime_s"),
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
    agentKeyUniq: uniqueIndex("tacho_hosts_agent_key_uniq").on(
      t.orgId,
      t.agentKey,
    ),
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
    anthropicUserEmail: text("anthropic_user_email"),
    anthropicAccountUuid: text("anthropic_account_uuid"),
    anthropicAccountId: text("anthropic_account_id"),
    anthropicOrgUuid: text("anthropic_org_uuid"),
    apiKeySource: text("api_key_source"),
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
    permissionModeChanges: integer("permission_mode_changes")
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
    numTurns: integer("num_turns").notNull().default(0),
    numPrompts: integer("num_prompts").notNull().default(0),
    numModelCalls: integer("num_model_calls").notNull().default(0),
    numApiErrors: integer("num_api_errors").notNull().default(0),
    numApiRetries: integer("num_api_retries").notNull().default(0),
    numToolCalls: integer("num_tool_calls").notNull().default(0),
    numToolErrors: integer("num_tool_errors").notNull().default(0),
    numToolRejections: integer("num_tool_rejections").notNull().default(0),
    numToolAsks: integer("num_tool_asks").notNull().default(0),
    numSubagents: integer("num_subagents").notNull().default(0),
    numCompactions: integer("num_compactions").notNull().default(0),
    numModelSwitches: integer("num_model_switches").notNull().default(0),
    numNotifications: integer("num_notifications").notNull().default(0),
    numElicitations: integer("num_elicitations").notNull().default(0),
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
    webSearchRequests: integer("web_search_requests").notNull().default(0),
    webFetchRequests: integer("web_fetch_requests").notNull().default(0),
    totalCostMicros: bigint("total_cost_micros", { mode: "number" })
      .notNull()
      .default(0),
    costBasis: text("cost_basis"),
    hasUnknownModelCost: boolean("has_unknown_model_cost"),
    durationMs: integer("duration_ms"),
    apiDurationMs: integer("api_duration_ms"),
    apiDurationWithoutRetriesMs: integer("api_duration_without_retries_ms"),
    toolDurationMs: integer("tool_duration_ms"),
    activeTimeS: integer("active_time_s"),
    ttftFirstMs: integer("ttft_first_ms"),
    linesAdded: integer("lines_added").notNull().default(0),
    linesRemoved: integer("lines_removed").notNull().default(0),
    filesRead: integer("files_read").notNull().default(0),
    filesWritten: integer("files_written").notNull().default(0),
    filesDeleted: integer("files_deleted").notNull().default(0),
    commandsRun: integer("commands_run").notNull().default(0),
    networkCalls: integer("network_calls").notNull().default(0),
    commits: integer("commits").notNull().default(0),
    pullRequests: integer("pull_requests").notNull().default(0),
    subagentStats: jsonb("subagent_stats"),
    permissionDenials: jsonb("permission_denials"),
    modelsUsed: jsonb("models_used"),
    // Policy
    enforcementTier: text("enforcement_tier").notNull().default("observe"),
    bundleMode: text("bundle_mode"),
    bundleVersion: integer("bundle_version"),
    policyDecisions: integer("policy_decisions").notNull().default(0),
    policyDenies: integer("policy_denies").notNull().default(0),
    elevationsRequested: integer("elevations_requested").notNull().default(0),
    elevationsApproved: integer("elevations_approved").notNull().default(0),
    elevationsDenied: integer("elevations_denied").notNull().default(0),
    elevationsExpired: integer("elevations_expired").notNull().default(0),
    tokensIssued: integer("tokens_issued").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0),
    // Chain
    seqCount: bigint("seq_count", { mode: "number" }).notNull().default(0),
    genesisHash: text("genesis_hash"),
    lastHash: text("last_hash"),
    finalHash: text("final_hash"),
    checkpointCount: integer("checkpoint_count").notNull().default(0),
    lastCheckpointId: uuid("last_checkpoint_id"),
    chainVerified: boolean("chain_verified").notNull().default(true),
    chainBreakAtSeq: bigint("chain_break_at_seq", { mode: "number" }),
    telemetryGapCount: integer("telemetry_gap_count").notNull().default(0),
    unobservedTail: boolean("unobserved_tail").notNull().default(false),
    completenessGaps: jsonb("completeness_gaps")
      .notNull()
      .default(sql`'[]'::jsonb`),
    replayGrade: text("replay_grade"),
    evidenceManifestId: uuid("evidence_manifest_id"),
    // Presentation
    title: text("title"),
    lastPromptDigest: text("last_prompt_digest"),
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
    requests: integer("requests").notNull().default(0),
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
    webSearchRequests: integer("web_search_requests").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    apiDurationMs: integer("api_duration_ms").notNull().default(0),
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
    durationMs: integer("duration_ms"),
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
// Oxagen -> host commands (data-model 3.6, spec section 7.4).
export const tachoControlCommands = tachoSchema.table(
  "control_commands",
  {
    ...idMixin("tcm"),
    ...auditMixin(),
    ...orgScopeMixin(),
    hostId: uuid("host_id").notNull(),
    sessionId: uuid("session_id"),
    command: text("command").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    issuedByPrincipalId: uuid("issued_by_principal_id"),
    issuedByUserId: uuid("issued_by_user_id"),
    issuedAt: ts("issued_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    deliveredAt: ts("delivered_at"),
    acknowledgedAt: ts("acknowledged_at"),
    appliedAt: ts("applied_at"),
    appliedAtSeq: bigint("applied_at_seq", { mode: "number" }),
    outcome: text("outcome").notNull().default("pending"),
    outcomeDetail: text("outcome_detail"),
  },
  (t) => ({
    hostPendingIdx: index("tacho_control_commands_host_pending_idx").on(
      t.hostId,
      t.outcome,
      t.issuedAt,
    ),
    orgIdx: index("tacho_control_commands_org_idx").on(t.orgId, t.workspaceId),
    commandCheck: check(
      "tacho_control_commands_command_check",
      sql`${t.command} IN (${sql.raw(inList(TACHO_COMMANDS))})`,
    ),
    outcomeCheck: check(
      "tacho_control_commands_outcome_check",
      sql`${t.outcome} IN (${sql.raw(inList(TACHO_COMMAND_OUTCOMES))})`,
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
