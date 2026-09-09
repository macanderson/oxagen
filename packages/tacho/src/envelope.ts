/**
 * The `tacho/1.0` event envelope and its typed bodies.
 *
 * Design rule (docs/specs/tacho/data-model.md section 4): every body member
 * is named exactly as the ClickHouse column it lands in, and every envelope
 * group flattens to a fixed column prefix. `columns.ts` is the mechanical
 * flattening; `columns.test.ts` proves no body member lacks a column.
 *
 * Bodies are `.strict()` so schema drift in a producer is refused rather than
 * silently swallowed. The long tail of upstream attributes that has not been
 * promoted to a typed member travels in the envelope-level `attrs` map, so
 * nothing observable is dropped in the meantime.
 */
import { z } from "zod";
import { SHA256_DIGEST_PATTERN } from "./digest";
import { isProtocolTimestamp } from "./timestamp";

export const TACHO_ENVELOPE_VERSION = "tacho/1.0" as const;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const str = z.string().max(4096);
const short = z.string().max(512);
const u8 = z.number().int().min(0).max(255);
const u16 = z.number().int().min(0).max(65_535);
const u32 = z.number().int().min(0).max(4_294_967_295);
const u64 = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bool = z.boolean();
const ts = z.string().refine(isProtocolTimestamp, "protocol timestamp");
const json = z.unknown();

export const TACHO_RUNTIMES = [
  "claude-code",
  "claude-agent-sdk",
  "custom",
  "stella",
  "proxy",
] as const;
export const TACHO_FIDELITIES = ["sdk", "ambient", "proxy"] as const;
export const TACHO_SOURCES = [
  "hook",
  "otel_log",
  "otel_metric",
  "otel_span",
  "transcript",
  "result",
  "collector",
  "control_plane",
] as const;
export const ENFORCEMENT_TIERS = ["gateway", "harness", "observe"] as const;

export const TOOL_STATUSES = ["ok", "error", "rejected", "cancelled"] as const;
export const POLICY_DECISIONS = ["allow", "deny", "ask", "defer"] as const;
export const POLICY_SOURCES = [
  "bundle",
  "kernel",
  "human",
  "harness",
  "managed_settings",
] as const;
export const EFFECT_KINDS = [
  "file_read",
  "file_write",
  "file_edit",
  "file_delete",
  "command",
  "network",
  "git_commit",
  "git_push",
  "pr_open",
  "subagent",
  "other",
] as const;
export const GAP_CAUSES = [
  "buffer_full",
  "daemon_down",
  "http_hook_failed",
  "otel_missing",
  "spool_overflow",
] as const;
export const INCIDENT_KINDS = [
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

// ---------------------------------------------------------------------------
// Fact groups. A member appears in exactly one group; its name is its column.
// ---------------------------------------------------------------------------

/** Tool facts (data-model section 2.6, plus reference-only 2.6 additions). */
export const toolFacts = z.object({
  tool_name: short.optional(),
  tool_source: z
    .enum([
      "builtin",
      "mcp",
      "plugin",
      "skill",
      "foundry",
      "sdk_host_builtin_mcp",
    ])
    .optional(),
  mcp_server_name: short.optional(),
  mcp_tool_name: short.optional(),
  tool_use_id: short.optional(),
  parent_tool_use_id: short.optional(),
  tool_input_digest: digest.optional(),
  tool_input_bytes: u32.optional(),
  tool_output_digest: digest.optional(),
  tool_output_bytes: u32.optional(),
  tool_target: short.optional(),
  tool_targets: z.array(short).max(256).optional(),
  tool_language: short.optional(),
  tool_status: z.enum(TOOL_STATUSES).optional(),
  tool_error_class: short.optional(),
  tool_error_message_digest: digest.optional(),
  tool_duration_ms: u32.optional(),
  tool_blocked_on_user_ms: u32.optional(),
  tool_is_mutating: bool.optional(),
  tool_decision: z.enum(["accept", "reject"]).optional(),
  tool_decision_source: z
    .enum([
      "config",
      "hook",
      "user_permanent",
      "user_temporary",
      "user_abort",
      "user_reject",
      "tacho_policy",
      "unknown",
    ])
    .optional(),
  tool_denial_kind: short.optional(),
  tool_result_tokens: u32.optional(),
  batch_size: u8.optional(),
  batch_index: u8.optional(),
  attribution_skill: short.optional(),
  attribution_mcp_server: short.optional(),
  attribution_mcp_tool: short.optional(),
  effect_id: short.optional(),
  effect_kind: z.enum(EFFECT_KINDS).optional(),
});

/** Model-call facts (data-model section 2.7, plus refusal and attribution). */
export const modelFacts = z.object({
  provider: short.optional(),
  model: short.optional(),
  canonical_model: short.optional(),
  input_tokens: u32.optional(),
  output_tokens: u32.optional(),
  cache_read_tokens: u32.optional(),
  cache_creation_tokens: u32.optional(),
  cache_creation_5m_tokens: u32.optional(),
  cache_creation_1h_tokens: u32.optional(),
  thinking_tokens: u32.optional(),
  web_search_requests: u16.optional(),
  web_fetch_requests: u16.optional(),
  iterations: u8.optional(),
  cost_usd_micros: u64.optional(),
  cost_basis: short.optional(),
  context_window: u32.optional(),
  max_output_tokens: u32.optional(),
  service_tier: short.optional(),
  speed: short.optional(),
  inference_geo: short.optional(),
  stop_reason: short.optional(),
  stop_sequence: short.optional(),
  stop_details: json.optional(),
  ttft_ms: u32.optional(),
  api_duration_ms: u32.optional(),
  time_to_request_ms: u32.optional(),
  first_content_frame_ms: u32.optional(),
  attempt: u8.optional(),
  api_status_code: u16.optional(),
  api_error_class: short.optional(),
  api_error_message_digest: digest.optional(),
  llm_request_context: short.optional(),
  context_management: json.optional(),
  api_block_index: u16.optional(),
  truncated_after_output: bool.optional(),
  request_id: short.optional(),
  client_request_id: short.optional(),
  message_id: short.optional(),
  message_uuid: short.optional(),
  refusal_category: short.optional(),
  refusal_has_category: bool.optional(),
  refusal_has_explanation: bool.optional(),
  server_fallback_hop: bool.optional(),
  api_retry_attempt: u8.optional(),
  api_retry_max: u8.optional(),
  api_retry_delay_ms: u32.optional(),
  api_retry_no_response: bool.optional(),
  skill_name: short.optional(),
  plugin_name: short.optional(),
  marketplace_name: short.optional(),
  plugin_id_hash: short.optional(),
  workflow_run_id: short.optional(),
  workflow_name: short.optional(),
  workspace_host_paths: z.array(short).max(64).optional(),
});

/** Prompt and response facts (data-model section 2.8). */
export const promptFacts = z.object({
  prompt_digest: digest.optional(),
  prompt_length: u32.optional(),
  prompt_source: short.optional(),
  prompt_origin: json.optional(),
  command_name: short.optional(),
  command_source: short.optional(),
  command_input_digest: digest.optional(),
  is_meta: bool.optional(),
  is_sidechain: bool.optional(),
  interrupted_message_id: short.optional(),
  response_digest: digest.optional(),
  response_length: u32.optional(),
  last_assistant_message_digest: digest.optional(),
  message_index: u16.optional(),
  message_final: bool.optional(),
  interaction_duration_ms: u32.optional(),
  interaction_sequence: u32.optional(),
  background_tasks: json.optional(),
  session_crons: json.optional(),
  stop_hook_active: bool.optional(),
  stop_failure_error_type: short.optional(),
  queued_turn_count: u16.optional(),
  structured_output_digest: digest.optional(),
  turn_duration_ms: u32.optional(),
  turn_message_count: u32.optional(),
});

/** Policy, approval, token facts (data-model section 2.9). */
export const policyFacts = z.object({
  policy_decision: z.enum(POLICY_DECISIONS).optional(),
  policy_rule: short.optional(),
  policy_source: z.enum(POLICY_SOURCES).optional(),
  policy_reason_code: short.optional(),
  policy_reason_digest: digest.optional(),
  capability_id: short.optional(),
  risk_grade: z.enum(["low", "medium", "high", "critical"]).optional(),
  bundle_version: u32.optional(),
  bundle_mode: z.enum(["observe", "enforce"]).optional(),
  deny_generation_org: u32.optional(),
  deny_generation_ws: u32.optional(),
  approval_id: short.optional(),
  approver_principal_id: short.optional(),
  token_id: short.optional(),
  token_expires_at: ts.optional(),
  token_use_limit: u8.optional(),
  authorization_decision_id: short.optional(),
  requesting_span_seq: u64.optional(),
});

/** Subagent facts (data-model section 2.10). */
export const subagentFacts = z.object({
  subagent_description: short.optional(),
  subagent_source: short.optional(),
  subagent_is_async: bool.optional(),
  subagent_total_tokens: u32.optional(),
  subagent_tool_uses: u32.optional(),
  subagent_model: short.optional(),
  subagent_final_model: short.optional(),
  subagent_model_swapped: bool.optional(),
  subagent_transcript_path: str.optional(),
  subagent_result_digest: digest.optional(),
  subagent_duration_ms: u32.optional(),
});

/** Harness health facts (data-model section 2.11). */
export const healthFacts = z.object({
  hook_name: short.optional(),
  hook_type: short.optional(),
  hook_matcher: short.optional(),
  hook_source: short.optional(),
  hook_count: u8.optional(),
  hook_success: u8.optional(),
  hook_blocking: u8.optional(),
  hook_nonblocking_error: u8.optional(),
  hook_cancelled: u8.optional(),
  hook_total_duration_ms: u32.optional(),
  hook_managed_only: bool.optional(),
  hook_safe_mode: bool.optional(),
  hook_prevented_continuation: bool.optional(),
  mcp_server_scope: short.optional(),
  mcp_transport: short.optional(),
  mcp_status: short.optional(),
  mcp_error_code: short.optional(),
  mcp_is_plugin: bool.optional(),
  mcp_connect_ms: u32.optional(),
  config_file_path: str.optional(),
  config_source: short.optional(),
  config_digest_before: digest.optional(),
  config_digest_after: digest.optional(),
  config_tacho_hooks_present: bool.optional(),
  instructions_file_path: str.optional(),
  instructions_memory_type: short.optional(),
  instructions_load_reason: short.optional(),
  instructions_digest: digest.optional(),
  internal_error_name: short.optional(),
  auth_action: short.optional(),
  auth_success: bool.optional(),
  auth_method: short.optional(),
  auth_error_category: short.optional(),
  auth_status_code: u16.optional(),
  plugin_install_status: short.optional(),
  plugin_install_name: short.optional(),
});

/** Context lifecycle facts (data-model section 2.12 and section 6). */
export const lifecycleFacts = z.object({
  compact_trigger: short.optional(),
  compact_custom_instructions_digest: digest.optional(),
  tokens_before: u32.optional(),
  tokens_after: u32.optional(),
  model_from: short.optional(),
  model_to: short.optional(),
  model_switch_reason: short.optional(),
  permission_mode_from: short.optional(),
  permission_mode_to: short.optional(),
  permission_mode_trigger: short.optional(),
  rate_limit_kind: short.optional(),
  rate_limit_reset_at: ts.optional(),
  fast_mode_state: short.optional(),
  notification_type: short.optional(),
  task_name: short.optional(),
  task_id: short.optional(),
  cwd_previous: str.optional(),
  cwd_new: str.optional(),
  directory_added: str.optional(),
  directory_add_method: short.optional(),
  worktree_reason: short.optional(),
  elicitation_server: short.optional(),
  elicitation_message_type: short.optional(),
  elicitation_prompt_digest: digest.optional(),
  elicitation_response_digest: digest.optional(),
  setup_trigger: short.optional(),
  teammate_name: short.optional(),
  file_changed_path: str.optional(),
  queue_operation: short.optional(),
  session_start_source: short.optional(),
  session_end_reason: short.optional(),
  session_outcome: z
    .enum(["completed", "aborted", "crashed", "unknown"])
    .optional(),
  terminal_reason: short.optional(),
  resume_of_session_id: short.optional(),
  resume_last_seq_seen: u64.optional(),
  fork_of_session_id: short.optional(),
});

/** Gap, incident, chain facts (data-model section 2.13). */
export const integrityFacts = z.object({
  gap_dropped_count: u32.optional(),
  gap_duration_ms: u32.optional(),
  gap_cause: z.enum(GAP_CAUSES).optional(),
  incident_kind: z.enum(INCIDENT_KINDS).optional(),
  incident_severity: u8.optional(),
  incident_evidence: json.optional(),
  kill_signal: short.optional(),
  kill_outcome: short.optional(),
  checkpoint_id: short.optional(),
  checkpoint_event_count: u64.optional(),
  checkpoint_chain_head: digest.optional(),
  checkpoint_device_signature: str.optional(),
  checkpoint_device_key_fingerprint: short.optional(),
});

/** Session inventory captured once at genesis (data-model section 3.2). */
export const inventoryFacts = z.object({
  tools_available: z.array(short).max(2048).optional(),
  mcp_servers: json.optional(),
  agents_available: z.array(short).max(1024).optional(),
  skills_available: z.array(short).max(1024).optional(),
  slash_commands: z.array(short).max(1024).optional(),
  plugins: json.optional(),
  plugin_errors: json.optional(),
  mcp_server_errors: json.optional(),
  harness_capabilities: z.array(short).max(256).optional(),
  settings_sources: json.optional(),
  hooks_registered: json.optional(),
  env_snapshot: json.optional(),
  memory_paths: json.optional(),
  available_models: z.array(short).max(64).optional(),
  fallback_models: z.array(short).max(64).optional(),
  effort_level_setting: short.optional(),
  sandbox_enabled: bool.optional(),
  auto_compact_enabled: bool.optional(),
  always_thinking_enabled: bool.optional(),
  prompt_cache_ttl: short.optional(),
  default_permission_mode_setting: short.optional(),
  analytics_disabled: bool.optional(),
  product_feedback_disabled: bool.optional(),
  fast_mode_disabled_reason: short.optional(),
  session_title: short.optional(),
  transcript_path: str.optional(),
});

/** Session totals sealed at the end (data-model section 3.2 totals). */
export const totalsFacts = z.object({
  num_turns: u32.optional(),
  num_prompts: u32.optional(),
  num_model_calls: u32.optional(),
  num_api_errors: u32.optional(),
  num_api_retries: u32.optional(),
  num_tool_calls: u32.optional(),
  num_tool_errors: u32.optional(),
  num_tool_rejections: u32.optional(),
  num_tool_asks: u32.optional(),
  num_subagents: u32.optional(),
  num_compactions: u32.optional(),
  num_model_switches: u32.optional(),
  num_notifications: u32.optional(),
  num_elicitations: u32.optional(),
  total_input_tokens: u64.optional(),
  total_output_tokens: u64.optional(),
  total_cache_read_tokens: u64.optional(),
  total_cache_creation_tokens: u64.optional(),
  total_cache_creation_5m_tokens: u64.optional(),
  total_cache_creation_1h_tokens: u64.optional(),
  total_thinking_tokens: u64.optional(),
  total_web_search_requests: u32.optional(),
  total_web_fetch_requests: u32.optional(),
  total_cost_usd_micros: u64.optional(),
  has_unknown_model_cost: bool.optional(),
  duration_ms: u32.optional(),
  api_duration_without_retries_ms: u32.optional(),
  tool_duration_ms_total: u32.optional(),
  active_time_s: u32.optional(),
  ttft_first_ms: u32.optional(),
  lines_added: u32.optional(),
  lines_removed: u32.optional(),
  files_read: u32.optional(),
  files_written: u32.optional(),
  files_deleted: u32.optional(),
  commands_run: u32.optional(),
  network_calls: u32.optional(),
  commits: u32.optional(),
  pull_requests: u32.optional(),
  subagent_stats: json.optional(),
  permission_denials: json.optional(),
  models_used: json.optional(),
  is_error: bool.optional(),
  api_error_status: u16.optional(),
  seq_count: u64.optional(),
  final_hash: digest.optional(),
  genesis_hash: digest.optional(),
  telemetry_gap_count: u32.optional(),
  unobserved_tail: bool.optional(),
  completeness_gaps: z.array(short).max(32).optional(),
});

const allFacts = toolFacts
  .merge(modelFacts)
  .merge(promptFacts)
  .merge(policyFacts)
  .merge(subagentFacts)
  .merge(healthFacts)
  .merge(lifecycleFacts)
  .merge(integrityFacts)
  .merge(inventoryFacts)
  .merge(totalsFacts);

/** Every body member name; also the body-derived ClickHouse column set. */
export const BODY_MEMBER_NAMES = Object.keys(allFacts.shape) as Array<
  keyof typeof allFacts.shape
>;

// ---------------------------------------------------------------------------
// Kinds and their bodies
// ---------------------------------------------------------------------------

function body<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

const pick = <K extends keyof typeof allFacts.shape>(...keys: K[]) => {
  const shape = {} as Pick<typeof allFacts.shape, K>;
  for (const key of keys) {
    shape[key] = allFacts.shape[key];
  }
  return shape;
};

const toolKeys = Object.keys(toolFacts.shape) as Array<
  keyof typeof toolFacts.shape
>;
const modelKeys = Object.keys(modelFacts.shape) as Array<
  keyof typeof modelFacts.shape
>;
const promptKeys = Object.keys(promptFacts.shape) as Array<
  keyof typeof promptFacts.shape
>;
const policyKeys = Object.keys(policyFacts.shape) as Array<
  keyof typeof policyFacts.shape
>;
const subagentKeys = Object.keys(subagentFacts.shape) as Array<
  keyof typeof subagentFacts.shape
>;
const healthKeys = Object.keys(healthFacts.shape) as Array<
  keyof typeof healthFacts.shape
>;
const lifecycleKeys = Object.keys(lifecycleFacts.shape) as Array<
  keyof typeof lifecycleFacts.shape
>;
const integrityKeys = Object.keys(integrityFacts.shape) as Array<
  keyof typeof integrityFacts.shape
>;
const inventoryKeys = Object.keys(inventoryFacts.shape) as Array<
  keyof typeof inventoryFacts.shape
>;
const totalsKeys = Object.keys(totalsFacts.shape) as Array<
  keyof typeof totalsFacts.shape
>;

export const KIND_BODIES = {
  // Lifecycle
  agent_start: body({
    ...pick(...lifecycleKeys),
    ...pick(...inventoryKeys),
    ...pick("model", "provider", "canonical_model"),
  }),
  agent_stop: body({ ...pick(...lifecycleKeys), ...pick(...totalsKeys) }),
  turn_start: body({ ...pick(...promptKeys), ...pick(...policyKeys) }),
  turn_end: body({ ...pick(...promptKeys), ...pick("model") }),
  // Tools
  tool_requested: body({ ...pick(...toolKeys), ...pick(...policyKeys) }),
  tool_call: body({ ...pick(...toolKeys) }),
  file_io: body({ ...pick(...toolKeys) }),
  network: body({ ...pick(...toolKeys) }),
  command: body({ ...pick(...toolKeys) }),
  // Model
  llm_call: body({
    ...pick(...modelKeys),
    ...pick("mcp_server_name", "mcp_tool_name"),
  }),
  // Policy
  policy_decision: body({ ...pick(...toolKeys), ...pick(...policyKeys) }),
  approval_request: body({ ...pick(...toolKeys), ...pick(...policyKeys) }),
  approval_decision: body({ ...pick(...toolKeys), ...pick(...policyKeys) }),
  token_issued: body({ ...pick(...policyKeys) }),
  token_use: body({ ...pick(...toolKeys), ...pick(...policyKeys) }),
  token_denied: body({ ...pick(...toolKeys), ...pick(...policyKeys) }),
  // Subagents
  subagent_start: body({ ...pick(...subagentKeys), ...pick("tool_use_id") }),
  subagent_stop: body({
    ...pick(...subagentKeys),
    ...pick("tool_use_id", "tool_status"),
  }),
  // Errors and integrity
  error: body({
    ...pick(...modelKeys),
    ...pick(...promptKeys),
    ...pick(...healthKeys),
    ...pick("mcp_server_name", "mcp_tool_name"),
  }),
  telemetry_gap: body({ ...pick(...integrityKeys) }),
  checkpoint: body({ ...pick(...integrityKeys) }),
  // Vendor-namespaced harness lifecycle (CGP U3: names with ":" are namespaced).
  "oxagen:compaction": body({
    ...pick(...lifecycleKeys),
    ...pick(...modelKeys),
  }),
  "oxagen:config_change": body({
    ...pick(...healthKeys),
    ...pick(...integrityKeys),
  }),
  "oxagen:instructions_loaded": body({ ...pick(...healthKeys) }),
  "oxagen:hook_health": body({ ...pick(...healthKeys) }),
  "oxagen:mcp_connection": body({
    ...pick(...healthKeys),
    ...pick("mcp_server_name", "mcp_tool_name"),
  }),
  "oxagen:notification": body({
    ...pick(...lifecycleKeys),
    ...pick(...inventoryKeys),
  }),
  "oxagen:message": body({ ...pick(...promptKeys), ...pick(...modelKeys) }),
  "oxagen:model_switch": body({ ...pick(...lifecycleKeys) }),
  "oxagen:task": body({ ...pick(...lifecycleKeys) }),
  "oxagen:worktree": body({ ...pick(...lifecycleKeys) }),
  "oxagen:cwd_change": body({ ...pick(...lifecycleKeys) }),
  "oxagen:file_changed": body({ ...pick(...lifecycleKeys) }),
  "oxagen:elicitation": body({ ...pick(...lifecycleKeys) }),
  "oxagen:rate_limit": body({
    ...pick(...lifecycleKeys),
    ...pick(...modelKeys),
  }),
  "oxagen:permission_mode_change": body({ ...pick(...lifecycleKeys) }),
  "oxagen:queue": body({ ...pick(...lifecycleKeys), ...pick(...promptKeys) }),
  "oxagen:auth": body({ ...pick(...healthKeys) }),
  "oxagen:plugin_install": body({ ...pick(...healthKeys) }),
  "oxagen:api_retry": body({
    ...pick(...modelKeys),
    ...pick("mcp_server_name", "mcp_tool_name"),
  }),
  "oxagen:api_refusal": body({
    ...pick(...modelKeys),
    ...pick("mcp_server_name", "mcp_tool_name"),
  }),
  "oxagen:unobserved_session": body({
    ...pick(...integrityKeys),
    ...pick(...inventoryKeys),
  }),
  "oxagen:hooks_removed": body({
    ...pick(...integrityKeys),
    ...pick(...healthKeys),
  }),
  "oxagen:kill_attempted": body({ ...pick(...integrityKeys) }),
  "oxagen:command_applied": body({
    ...pick(...policyKeys),
    ...pick(...integrityKeys),
  }),
} as const;

export type TachoKind = keyof typeof KIND_BODIES;
export const TACHO_KINDS = Object.keys(KIND_BODIES) as TachoKind[];

// ---------------------------------------------------------------------------
// Envelope groups (data-model sections 2.1 to 2.5, 2.13, 2.14)
// ---------------------------------------------------------------------------

export const agentIdentitySchema = z
  .object({
    agent_key: short,
    fleet_id: short,
    runtime: z.enum(TACHO_RUNTIMES),
    harness: short,
    harness_version: short.optional(),
    wrapper_version: short,
    attestation: digest.optional(),
    host_enrollment_id: short.optional(),
    agent_principal_id: short.optional(),
    initiating_principal_id: short.optional(),
    enforcement_tier: z.enum(ENFORCEMENT_TIERS).optional(),
  })
  .strict();

export const subagentIdentitySchema = z
  .object({
    subagent_id: short,
    subagent_type: short.optional(),
    spawn_depth: u8.optional(),
    spawn_tool_use_id: short.optional(),
  })
  .strict();

export const turnRefSchema = z
  .object({
    turn_seq: u32.optional(),
    prompt_id: short.optional(),
    turn_id: short.optional(),
  })
  .strict();

export const contextSchema = z
  .object({
    cwd: str.optional(),
    project_dir: str.optional(),
    git_branch: short.optional(),
    git_head_sha: short.optional(),
    git_remote_digest: digest.optional(),
    git_dirty: bool.optional(),
    worktree_path: str.optional(),
    worktree_branch: short.optional(),
    permission_mode: short.optional(),
    effort: short.optional(),
    model: short.optional(),
    entrypoint: short.optional(),
    query_source: short.optional(),
    session_kind: short.optional(),
    terminal_type: short.optional(),
    app_version: short.optional(),
    output_style: short.optional(),
  })
  .strict();

export const hostSchema = z
  .object({
    hostname_digest: digest.optional(),
    os_type: short.optional(),
    os_version: short.optional(),
    host_arch: short.optional(),
    os_user_digest: digest.optional(),
    claude_pid: u32.optional(),
    claude_ppid: u32.optional(),
    claude_parent_process: short.optional(),
    claude_execpath: str.optional(),
    is_child_session: bool.optional(),
    bridge_session_id: short.optional(),
    has_tty: bool.optional(),
  })
  .strict();

export const anthropicSchema = z
  .object({
    user_id_hash: short.optional(),
    user_email: short.optional(),
    account_uuid: short.optional(),
    account_id: short.optional(),
    org_uuid: short.optional(),
    api_key_source: short.optional(),
  })
  .strict();

export const spanSchema = z
  .object({
    trace_id: short.optional(),
    span_id: short.optional(),
    parent_span_id: short.optional(),
  })
  .strict();

export const contentSchema = z
  .object({
    digest: digest.optional(),
    bytes_ref: str.optional(),
    redactions: z
      .array(
        z
          .object({
            path: short,
            reason: short,
            original_digest: digest,
          })
          .strict(),
      )
      .max(256)
      .default([]),
  })
  .strict();

const envelopeBase = z.object({
  v: z.literal(TACHO_ENVELOPE_VERSION),
  event_id: short,
  event_id_idem: z.string().regex(/^evt_[0-9a-f]{64}$/),
  session_id: short,
  session_uuid: z.string().uuid(),
  root_session_uuid: z.string().uuid(),
  parent_session_uuid: z.string().uuid().optional(),
  seq: u64,
  ts: ts,
  fidelity: z.enum(TACHO_FIDELITIES),
  source: z.enum(TACHO_SOURCES),
  hook_event_name: short.optional(),
  hook_source_kind: short.optional(),
  otel_event_name: short.optional(),
  harness_event_sequence: u64.optional(),
  agent: agentIdentitySchema,
  subagent: subagentIdentitySchema.optional(),
  turn: turnRefSchema.optional(),
  context: contextSchema.optional(),
  host: hostSchema.optional(),
  anthropic: anthropicSchema.optional(),
  span: spanSchema.optional(),
  attrs: z.record(z.string().max(256), z.string().max(4096)).default({}),
  content: contentSchema.optional(),
  raw_source_digest: digest.optional(),
  prev_hash: digest,
  hash: digest,
});

type KindMember<K extends TachoKind> = z.ZodObject<
  (typeof envelopeBase)["shape"] & {
    kind: z.ZodLiteral<K>;
    body: (typeof KIND_BODIES)[K];
  }
>;

function member<K extends TachoKind>(kind: K): KindMember<K> {
  return envelopeBase.extend({
    kind: z.literal(kind),
    body: KIND_BODIES[kind],
  }) as unknown as KindMember<K>;
}

/** Distributed over every kind, so narrowing on `kind` narrows `body`. */
type AnyKindMember = { [K in TachoKind]: KindMember<K> }[TachoKind];

const members = TACHO_KINDS.map((kind) => member(kind)) as unknown as [
  AnyKindMember,
  AnyKindMember,
  ...AnyKindMember[],
];

/** The wire schema: one envelope, discriminated on `kind`. */
export const tachoEventSchema = z.discriminatedUnion("kind", members);

export type TachoEvent = z.infer<typeof tachoEventSchema>;
export type TachoEventInput = z.input<typeof tachoEventSchema>;
export type TachoEventBody = z.infer<typeof allFacts>;

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** The unhashed shape a producer builds before `chain.ts` seals it. */
export type UnsealedTachoEvent = DistributiveOmit<
  TachoEventInput,
  "prev_hash" | "hash" | "event_id_idem" | "seq"
>;

/** The body type of one kind, for producers that build events by kind. */
export type BodyOf<K extends TachoKind> = z.input<(typeof KIND_BODIES)[K]>;

export function parseTachoEvent(value: unknown): TachoEvent {
  return tachoEventSchema.parse(value);
}

export function isTachoKind(value: string): value is TachoKind {
  return Object.prototype.hasOwnProperty.call(KIND_BODIES, value);
}
