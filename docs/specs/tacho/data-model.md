# Tacho data model — every observable fact, and the column it lands in

**Status:** Proposed (companion to `spec.md` §6.5; this file is the column-level contract)

**Ground truth:** every source field below was captured from a real Claude Code 2.1.263 session on 2026-09-08 (a `-p` run with hooks on all 33 events, the OpenTelemetry logs/metrics/traces exporters pointed at a local OTLP receiver, the session transcript and its subagent transcript, and the `--output-format json` result), cross-checked against the published hook and monitoring references. Fields that exist in the reference but did not fire in the probe are marked `ref`.

## 0. Principles

1. **Nothing observable is dropped.** Every scalar we can see gets a typed column. Nested or open-ended data gets a typed JSON column with a documented shape, never an untyped blob. The long tail of OpenTelemetry attributes we have not modelled yet lands in `attrs` (a string map) so a new upstream attribute is captured the day it appears and promoted to a column later without loss.
2. **Bodies are digested, content is governed.** Prompts, tool inputs, tool outputs, and model responses are always digested and size-counted. Their bytes are stored only under a workspace retention policy (`content_exact`), and then in tenant-encrypted blobs referenced by `bytes_ref`, never in ClickHouse or Neo4j. `tool_target` (a path, URL host, or the first 512 bytes of a command) is the one content-bearing column kept always, because an audit without it is useless.
3. **Secrets never land.** The collector denylists environment names matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` before recording `env_snapshot`; the probe showed `ANTHROPIC_API_KEY` in the hook environment, which is exactly what this rule exists for.
4. **Tenant identity is stamped, never read.** `org_id` / `workspace_id` come from the API key scope on ingest. Anthropic-side identifiers that Claude Code reports (`user.account_uuid`, `organization.id`, `user.email`, the hashed `user.id`) are recorded as *observations* in their own columns and never used for scoping.
5. **Three planes, one identity.** ClickHouse holds every event. Postgres holds the session, host, model, file, command, incident, and checkpoint records that need RLS, joins, and indefinite retention. Every row in both carries `session_uuid`.

## 1. Sources and what each one uniquely contributes

| Source | Unique facts | Cadence |
|---|---|---|
| Hook stdin (33 events) | authoritative tool input/response, `tool_use_id`, `prompt_id`, `permission_mode` at the moment, subagent identity, `transcript_path`, `cwd`, prompt text, stop state (`background_tasks`, `session_crons`), instructions loaded, config changes, compaction, worktree, teammate, task, elicitation, model switch | per action |
| Hook process environment | `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_EFFORT`, `CLAUDE_PID`, `CLAUDE_CODE_EXECPATH` (installed version path), `CLAUDE_CODE_AGENT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_WORKTREE_BASE_DIR`, `CLAUDE_PROJECT_DIR`, `SHELL`, `TERM_PROGRAM` | per session (first hook) |
| OTel resource | `host.arch`, `os.type`, `os.version`, `service.version` | per export |
| OTel standard attrs | `user.id` (sha256 hash), `user.email`, `user.account_uuid`, `user.account_id`, `organization.id`, `terminal.type`, `app.version`, `session.id`, `prompt.id`, `event.sequence`, `event.timestamp` | every record |
| OTel events | `api_request` (model, tokens by tier, `cost_usd_micros`, `duration_ms`, `request_id`, `client_request_id`, `speed`, `query_source`, `agent.name`), `api_error` (`attempt`, `status_code`, `error`), `tool_decision` (`decision`, `source`, `tool_source`, `tool_parameters`), `tool_result` (`success`, sizes), `user_prompt`, `assistant_response`, `subagent_completed` (`total_tokens`, `total_tool_uses`, `is_async`, `model_swapped`, `final_model`, `agent.source`), `hook_registered`, `hook_execution_start/complete` (counts, `total_duration_ms`, `hook_source`, `managed_only`, `safe_mode`), `mcp_server_connection` (`server_name`, `server_scope`, `transport_type`, `status`, `error_code`), `internal_error` (`error_name`) | per action |
| OTel metrics | `session.count{start_type}`, `cost.usage{model,query_source,agent.name}`, `token.usage{type}`, `lines_of_code.count{type,model}`, `code_edit_tool.decision{decision,source,tool_name,language}`, `active_time.total{type}`, `commit.count`, `pull_request.count` (ref) | periodic |
| OTel spans | `interaction` (`interaction.sequence`, `interaction.duration_ms`, `user_prompt_length`), `llm_request` (`gen_ai.*`, `ttft_ms`, `stop_reason`, `attempt`, `llm_request.context`), `tool` (`file_path`, `full_command`, `subagent_type`, `agent_id`), `tool.execution` (`success`), `tool.blocked_on_user` (`decision`, `source`, wait `duration_ms`) plus trace/span/parent ids | per action |
| Transcript JSONL | `usage.cache_creation.ephemeral_5m/1h_input_tokens`, `output_tokens_details.thinking_tokens`, `server_tool_use.web_search/fetch_requests`, `service_tier`, `inference_geo`, `iterations[]`, `stop_details`, `context_management`, `container`, `diagnostics`, `requestId`, `apiBlockIndex`, `effort`, `attributionSkill/McpServer/McpTool`, `isApiErrorMessage`, `truncatedAfterOutput`; user records: `promptSource`, `origin`, `sessionKind`, `slug`, `isMeta`, `isSidechain`, `interruptedMessageId`, `toolDenialKind`, `sourceToolUseID`, `turnCompanion`, `mcpMeta`, `toolUseResult`; `system` records (`turn_duration`, `stop_hook_summary`, `thinking_tokens`, …); `cost-state` (`totalCostUSD`, `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`, `totalLinesAdded/Removed`, `modelUsage{}`); `permission-mode`, `mode`, `agent-setting`, `worktree-state`, `relocated`, `file-history-snapshot/delta`, `frame-link`, `bridge-session`, `history-suppression`, `queue-operation`, `attachment{deferred_tools_delta, agent_listing_delta, mcp_instructions_delta, skill_listing, output_style, total_tokens_reminder}`, `last-prompt`, `ai-title`, `agent-name`; subagent `meta.json` (`agentType`, `description`, `toolUseId`, `spawnDepth`) | tailed by the collector |
| `-p` result / stream-json | `system.init` (`tools[]`, `mcp_servers[{name,status}]`, `slash_commands[]`, `agents[]`, `skills[]`, `plugins[]`, `capabilities[]`, `output_style`, `apiKeySource`, `claude_code_version`, `permissionMode`, `analytics_disabled`, `memory_paths`, `fast_mode_state`); `result` (`total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `usage`, `modelUsage{contextWindow,maxOutputTokens,canonicalModel,provider,costBasis,thinkingTokens,webSearchRequests}`, `permission_denials[]`, `terminal_reason`, `stop_reason`, `is_error`, `api_error_status`, `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms`, `first_content_frame_ms`, `queued_turn_count`, `subagent_stats{}`, `origin`); `rate_limit_event` | headless runs only |
| Collector | dense `seq`, chain hashes, checkpoints, `received_at`, process observation (pid, ppid, parent process name, tty), git facts read from `cwd` (`HEAD`, remote digest, dirty flag), settings-file digests, hook presence, unobserved-session detection, spool state | per session / per poll |
| Control plane | stamped tenant, `agent_key`, principal ids, bundle version and deny generations at decision time, policy decisions, approvals, tokens, chain verification result | on ingest |

## 2. ClickHouse `tacho_events` — one row per event, every scalar typed

Engine `ReplacingMergeTree(received_at)`, `PARTITION BY toYYYYMM(ts)`, `ORDER BY (org_id, workspace_id, session_uuid, seq)`, with a skipping index on `event_id_idem` and `tool_use_id`. TTL follows `events` (90 days) unless the workspace's retention policy pins longer. Types: `LC` = `LowCardinality(String)`, `N(...)` = `Nullable`.

### 2.1 Tenancy and identity (stamped)
| Column | Type | From |
|---|---|---|
| `org_id`, `workspace_id` | String | API key scope |
| `host_enrollment_id` | String | key scope (`thst_`), empty for SDK agents |
| `agent_key` | String | ADR-024 key of host or agent |
| `agent_principal_id`, `initiating_principal_id` | String | registry |
| `runtime` | LC | `claude-code` \| `claude-agent-sdk` \| `custom` \| `stella` |
| `harness`, `harness_version` | LC, String | `claude-code`, `2.1.263` (OTel `service.version` / init `claude_code_version`) |
| `wrapper_version` | String | package version |
| `fidelity` | LC | `sdk` \| `ambient` \| `proxy` |
| `enforcement_tier` | LC | `gateway` \| `harness` \| `observe` (session-level, denormalised) |

### 2.2 Anthropic-side observations (never used for scoping)
| Column | Type | From |
|---|---|---|
| `anthropic_user_id_hash` | String | OTel `user.id` |
| `anthropic_user_email` | String | OTel `user.email` |
| `anthropic_account_uuid`, `anthropic_account_id` | String | OTel `user.account_uuid`, `user.account_id` |
| `anthropic_org_uuid` | String | OTel `organization.id` (also transcript `bridge-session.ownerOrganizationUuid`) |
| `api_key_source` | LC | init `apiKeySource` (`none` \| `ANTHROPIC_API_KEY` \| …) |

### 2.3 Session, causality, ordering
| Column | Type | From |
|---|---|---|
| `session_uuid` | UUID | uuidv5(host or agent, harness session id) |
| `harness_session_id` | String | hook `session_id` |
| `root_session_uuid`, `parent_session_uuid` | UUID, N(UUID) | subagent linkage |
| `subagent_id`, `subagent_type` | String, LC | hook `agent_id` / `agent_type` |
| `spawn_depth` | UInt8 | `meta.json.spawnDepth` |
| `spawn_tool_use_id` | String | `meta.json.toolUseId` / `SubagentStart` |
| `seq` | UInt64 | collector, dense from 0 |
| `event_id` | String | ULID |
| `event_id_idem` | String | `evt_` + sha256(session_uuid ‖ seq) |
| `ts` | DateTime64(3, 'UTC') | event time |
| `received_at` | DateTime64(3, 'UTC') | ingest |
| `turn_seq` | N(UInt32) | collector turn counter (1-based inside a turn) |
| `prompt_id` | N(UUID) | hook `prompt_id` / OTel `prompt.id` |
| `turn_id`, `message_id`, `message_uuid` | String | `MessageDisplay.turn_id/message_id`, OTel `message.uuid` |
| `request_id`, `client_request_id` | String | OTel / transcript `requestId` |
| `tool_use_id`, `parent_tool_use_id` | String | hooks / transcript `sourceToolUseID` |
| `trace_id`, `span_id`, `parent_span_id` | String | OTel spans, propagated `traceparent` |
| `harness_event_sequence` | N(UInt64) | OTel `event.sequence` |
| `interaction_sequence` | N(UInt32) | span `interaction.sequence` |

### 2.4 Kind and source
| Column | Type | Values |
|---|---|---|
| `kind` | LC | tacho kind (`agent_start`, `turn_start`, `tool_requested`, `tool_call`, `llm_call`, `policy_decision`, `approval_request`, `approval_decision`, `token_issued`, `token_use`, `token_denied`, `file_io`, `network`, `command`, `subagent_start`, `subagent_stop`, `agent_stop`, `error`, `telemetry_gap`, `checkpoint`, `oxagen:compaction`, `oxagen:config_change`, `oxagen:instructions_loaded`, `oxagen:hook_health`, `oxagen:mcp_connection`, `oxagen:notification`, `oxagen:message`, `oxagen:model_switch`, `oxagen:task`, `oxagen:worktree`, `oxagen:cwd_change`, `oxagen:file_changed`, `oxagen:elicitation`, `oxagen:rate_limit`, `oxagen:unobserved_session`, `oxagen:hooks_removed`, `oxagen:kill_attempted`, `oxagen:permission_mode_change`, `oxagen:queue`) |
| `source` | LC | `hook` \| `otel_log` \| `otel_metric` \| `otel_span` \| `transcript` \| `result` \| `collector` \| `control_plane` |
| `hook_event_name` | LC | the Claude Code event, when `source = hook` |
| `hook_source_kind` | LC | `SessionStart.source` (`startup`/`resume`/`clear`/`compact`/`fork`), `SessionEnd.reason`, `PreCompact.trigger`, `Notification` type |
| `otel_event_name` | LC | `api_request`, `tool_decision`, … |

### 2.5 Context at the moment of the event
| Column | Type | From |
|---|---|---|
| `cwd`, `project_dir` | String | hook `cwd`, env `CLAUDE_PROJECT_DIR` |
| `git_branch` | String | transcript `gitBranch` / collector |
| `git_head_sha` | String | collector reads `.git/HEAD` at turn start |
| `git_remote_digest` | String | sha256 of normalised origin URL (repo identity without leaking the URL) |
| `git_dirty` | N(Bool) | collector `git status --porcelain` at turn start |
| `worktree_path`, `worktree_branch` | String | transcript `worktree-state`, `WorktreeCreate` hook |
| `permission_mode` | LC | hook `permission_mode` |
| `effort` | LC | env `CLAUDE_EFFORT` / transcript `effort` |
| `model` | LC | OTel `model` / transcript `message.model` |
| `entrypoint` | LC | env `CLAUDE_CODE_ENTRYPOINT` (`cli`, `sdk-cli`, `sdk-ts`, `sdk-py`, …) |
| `query_source` | LC | OTel `query_source` (`main`, `sdk`, `compact`, …) |
| `session_kind` | LC | transcript `sessionKind` (`interactive`, `bg`, …) |
| `terminal_type` | LC | OTel `terminal.type` |
| `app_version` | String | OTel `app.version` |
| `output_style` | LC | init / attachment `output_style` |

### 2.6 Tool facts (`tool_requested`, `tool_call`, `policy_decision`, `file_io`, `network`, `command`)
| Column | Type | From |
|---|---|---|
| `tool_name` | LC | hook `tool_name` |
| `tool_source` | LC | OTel `tool_source` (`builtin` \| `mcp` \| `plugin` \| `skill` \| `foundry`) |
| `mcp_server_name`, `mcp_tool_name` | String | parsed from `mcp__<server>__<tool>` |
| `tool_input_digest`, `tool_input_bytes` | String, UInt32 | collector |
| `tool_output_digest`, `tool_output_bytes` | String, UInt32 | collector |
| `tool_target` | String | path / URL host / first 512 bytes of command (see §0.2) |
| `tool_targets` | Array(String) | every path a multi-file tool touched |
| `tool_language` | LC | metric `code_edit_tool.decision.language` |
| `tool_status` | LC | `ok` \| `error` \| `rejected` \| `cancelled` |
| `tool_error_class`, `tool_error_message_digest` | LC, String | `PostToolUseFailure.error` |
| `tool_duration_ms` | N(UInt32) | hook `duration_ms` / OTel |
| `tool_blocked_on_user_ms` | N(UInt32) | span `tool.blocked_on_user.duration_ms` |
| `tool_is_mutating` | N(Bool) | bundle `tools[].read_only` negated |
| `tool_decision` | LC | OTel `decision` (`accept` \| `reject`) |
| `tool_decision_source` | LC | OTel `source` (`config`, `user_permanent`, `user_temporary`, `user_abort`, `user_reject`, `hook`, `tacho_policy`) |
| `tool_denial_kind` | LC | transcript `toolDenialKind` |
| `batch_size`, `batch_index` | N(UInt8) | `PostToolBatch.tool_calls[]` |
| `attribution_skill`, `attribution_mcp_server`, `attribution_mcp_tool` | String | transcript assistant record |
| `effect_id`, `effect_kind` | String, LC | collector (`file_write`, `file_read`, `file_delete`, `command`, `network`, `git_commit`, `git_push`, `pr_open`) |

### 2.7 Model-call facts (`llm_call`, `error` with `api_error`)
| Column | Type | From |
|---|---|---|
| `provider` | LC | result `modelUsage.provider` (`firstParty`, `bedrock`, `vertex`, `foundry`) |
| `canonical_model` | LC | result `canonicalModel` |
| `input_tokens`, `output_tokens` | UInt32 | OTel / transcript |
| `cache_read_tokens`, `cache_creation_tokens` | UInt32 | OTel |
| `cache_creation_5m_tokens`, `cache_creation_1h_tokens` | UInt32 | transcript `usage.cache_creation.*` |
| `thinking_tokens` | UInt32 | transcript `output_tokens_details.thinking_tokens` |
| `web_search_requests`, `web_fetch_requests` | UInt16 | transcript `server_tool_use.*` |
| `iterations` | UInt8 | transcript `usage.iterations[]` length |
| `cost_usd_micros` | UInt64 | OTel `cost_usd_micros` |
| `cost_basis` | LC | result `costBasis` (`list`, `unknown`) |
| `context_window`, `max_output_tokens` | N(UInt32) | result `modelUsage` |
| `service_tier`, `speed`, `inference_geo` | LC | transcript / OTel |
| `stop_reason`, `stop_sequence` | LC, String | transcript / span |
| `stop_details` | String (JSON) | transcript |
| `ttft_ms`, `api_duration_ms`, `time_to_request_ms`, `first_content_frame_ms` | N(UInt32) | span / result |
| `attempt` | UInt8 | OTel `attempt` |
| `api_status_code`, `api_error_class`, `api_error_message_digest` | N(UInt16), LC, String | `api_error` |
| `llm_request_context` | LC | span `llm_request.context` (`interaction`, `compact`, `title`, …) |
| `context_management` | String (JSON) | transcript |
| `api_block_index` | N(UInt16) | transcript `apiBlockIndex` |
| `truncated_after_output` | N(Bool) | transcript |

### 2.8 Prompt and response facts (`turn_start`, `oxagen:message`)
| Column | Type | From |
|---|---|---|
| `prompt_digest`, `prompt_length` | String, UInt32 | hook `prompt` (digested) / OTel `prompt_length` |
| `prompt_source` | LC | transcript `promptSource` (`user`, `sdk`, `slash_command`, `hook`, …) |
| `prompt_origin` | String (JSON) | transcript `origin` / result `origin` |
| `is_meta`, `is_sidechain` | N(Bool) | transcript |
| `interrupted_message_id` | String | transcript |
| `response_digest`, `response_length` | String, UInt32 | OTel `assistant_response` |
| `last_assistant_message_digest` | String | `Stop.last_assistant_message` |
| `message_index`, `message_final` | N(UInt16), N(Bool) | `MessageDisplay` |
| `interaction_duration_ms` | N(UInt32) | span |
| `background_tasks` | String (JSON) | `Stop.background_tasks[]` |
| `session_crons` | String (JSON) | `Stop.session_crons[]` |
| `stop_hook_active` | N(Bool) | `Stop` |
| `queued_turn_count` | N(UInt16) | result |

### 2.9 Policy, approval, token facts
| Column | Type | From |
|---|---|---|
| `policy_decision` | LC | `allow` \| `deny` \| `ask` \| `defer` |
| `policy_rule` | String | the matched Claude Code rule (`Bash(git push*)`) |
| `policy_source` | LC | `bundle` \| `kernel` \| `human` \| `harness` \| `managed_settings` |
| `policy_reason_code`, `policy_reason_digest` | LC, String | |
| `capability_id` | String | `claude.<tool>` or the Oxagen capability |
| `risk_grade` | LC | bundle |
| `bundle_version`, `bundle_mode` | UInt32, LC | bundle in force |
| `deny_generation_org`, `deny_generation_ws` | UInt32 | bundle in force |
| `approval_id` | String | `agent.approval_requests` public id |
| `approver_principal_id` | String | |
| `token_id`, `token_expires_at`, `token_use_limit` | String, N(DateTime64), N(UInt8) | mint |
| `authorization_decision_id` | String | `iam.authorization_decisions` |

### 2.10 Subagent facts (`subagent_start`, `subagent_stop`)
| Column | Type | From |
|---|---|---|
| `subagent_description` | String | `meta.json.description` |
| `subagent_source` | LC | OTel `agent.source` (`built-in`, `user`, `project`, `plugin`) |
| `subagent_is_async` | N(Bool) | OTel |
| `subagent_total_tokens`, `subagent_tool_uses` | N(UInt32) | OTel |
| `subagent_model`, `subagent_final_model`, `subagent_model_swapped` | LC, LC, N(Bool) | OTel |
| `subagent_transcript_path` | String | `SubagentStop.agent_transcript_path` |
| `subagent_result_digest` | String | `SubagentStop.last_assistant_message` |

### 2.11 Harness health (`oxagen:hook_health`, `oxagen:mcp_connection`, `oxagen:config_change`, `oxagen:instructions_loaded`)
| Column | Type | From |
|---|---|---|
| `hook_name`, `hook_type`, `hook_matcher`, `hook_source` | String, LC, String, LC | OTel `hook_registered` / `hook_execution_*` |
| `hook_count`, `hook_success`, `hook_blocking`, `hook_nonblocking_error`, `hook_cancelled` | N(UInt8) | OTel |
| `hook_total_duration_ms` | N(UInt32) | OTel |
| `hook_managed_only`, `hook_safe_mode` | N(Bool) | OTel |
| `hook_prevented_continuation` | N(Bool) | transcript `stop_hook_summary` |
| `mcp_server_scope`, `mcp_transport`, `mcp_status`, `mcp_error_code`, `mcp_is_plugin`, `mcp_connect_ms` | LC, LC, LC, LC, N(Bool), N(UInt32) | OTel `mcp_server_connection` |
| `config_file_path`, `config_source` | String, LC | `ConfigChange` (`user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills`) |
| `config_digest_before`, `config_digest_after` | String | collector |
| `config_tacho_hooks_present` | N(Bool) | collector (drives `hooks_removed`) |
| `instructions_file_path`, `instructions_memory_type`, `instructions_load_reason`, `instructions_digest` | String, LC, LC, String | `InstructionsLoaded` + collector digest |
| `internal_error_name` | String | OTel `internal_error` |

### 2.12 Context lifecycle (`oxagen:compaction`, `oxagen:model_switch`, `oxagen:permission_mode_change`, `oxagen:rate_limit`)
| Column | Type | From |
|---|---|---|
| `compact_trigger` | LC | `PreCompact.trigger` (`manual` \| `auto`) |
| `compact_custom_instructions_digest` | String | `PreCompact` |
| `tokens_before`, `tokens_after` | N(UInt32) | `PostCompact` (ref) / collector estimate |
| `model_from`, `model_to`, `model_switch_reason` | LC, LC, LC | `PreModelSwitch` / `PostModelSwitch` (ref) |
| `permission_mode_from`, `permission_mode_to` | LC | transcript `permission-mode` records |
| `rate_limit_kind`, `rate_limit_reset_at` | LC, N(DateTime64) | stream `rate_limit_event` |
| `fast_mode_state` | LC | result |

### 2.13 Gaps, incidents, chain
| Column | Type | From |
|---|---|---|
| `gap_dropped_count`, `gap_duration_ms`, `gap_cause` | N(UInt32), N(UInt32), LC | collector (`buffer_full`, `daemon_down`, `http_hook_failed`, `otel_missing`) |
| `incident_kind`, `incident_severity` | LC, UInt8 | collector / control plane |
| `kill_signal`, `kill_outcome` | LC | `oxagen:kill_attempted` |
| `prev_hash`, `hash` | String | chain |
| `checkpoint_id` | String | `tchk_` when `kind = checkpoint` |
| `chain_verified` | Bool | control plane recomputed `hash` on ingest |
| `content_digest`, `bytes_ref` | String | envelope `content` |
| `redactions` | String (JSON) | envelope `content.redactions[]` |

### 2.14 Host facts (denormalised for query speed)
| Column | Type | From |
|---|---|---|
| `hostname_digest` | String | sha256(hostname) |
| `os_type`, `os_version`, `host_arch` | LC, String, LC | OTel resource |
| `os_user_digest` | String | sha256(os user) |
| `claude_pid`, `claude_ppid` | N(UInt32) | env `CLAUDE_PID` / collector |
| `claude_parent_process` | LC | collector (`zsh`, `Code Helper`, `node`, `stella`, …) |
| `claude_execpath` | String | env `CLAUDE_CODE_EXECPATH` |
| `is_child_session` | N(Bool) | env `CLAUDE_CODE_CHILD_SESSION` |
| `bridge_session_id` | String | env / transcript `bridge-session` |
| `has_tty` | N(Bool) | collector |

### 2.15 Catch-alls
| Column | Type | Contents |
|---|---|---|
| `body` | String (JSON) | the kind-specific body from the envelope, redacted, validated against the package schema |
| `attrs` | Map(String, String) | every OTel attribute not promoted above, verbatim key and stringified value |
| `raw_source_digest` | String | sha256 of the raw hook stdin / OTLP record / transcript line the event was derived from |

## 3. Postgres (`agent` schema, RLS via `orgScopeMixin`)

### 3.1 `tacho_hosts` (`thst_`)
Identity: `agent_id`, `agent_principal_id`, `api_key_id`, `created_by_user_id`. Host: `hostname`, `hostname_digest`, `platform`, `os_version`, `arch`, `os_user`, `device_public_key`, `device_key_fingerprint`, `claude_version_at_enroll`, `claude_execpath`, `node_version`, `wrapper_version`, `shell`, `terminal_type_last`. Enrollment: `status` (`active`/`paused`/`suspended`/`revoked`), `enrollment_claims` jsonb, `enrollment_signature`, `expires_at`, `revoked_at`, `revoke_reason`, `managed` bool, `managed_settings_digest`, `user_settings_digest`, `project_settings_digests` jsonb. Policy: `mode`, `bundle_version_served`, `bundle_etag_served`, `deny_generation_org_seen`, `deny_generation_ws_seen`, `last_bundle_fetch_at`. Liveness: `last_seen_at`, `last_ingest_at`, `last_heartbeat_at`, `spool_depth`, `spool_oldest_at`, `hooks_ok`, `hooks_last_checked_at`, `otel_ok`, `daemon_version`, `daemon_uptime_s`. Counters: `sessions_count`, `unobserved_sessions_count`, `incidents_open`. Timestamps.

### 3.2 `tacho_sessions` (`tses_`)
Identity: `session_uuid` (unique), `harness_session_id`, `host_enrollment_id`, `agent_id`, `agent_principal_id`, `initiating_principal_id`, `initiating_user_id`, `root_session_id`, `parent_session_id`, `subagent_id`, `subagent_type`, `subagent_description`, `spawn_depth`, `spawn_tool_use_id`. Anthropic observations: `anthropic_user_id_hash`, `anthropic_user_email`, `anthropic_account_uuid`, `anthropic_account_id`, `anthropic_org_uuid`, `api_key_source`. Harness: `runtime`, `harness`, `harness_version`, `wrapper_version`, `entrypoint`, `query_source_initial`, `terminal_type`, `session_kind`, `is_child_session`, `bridge_session_id`, `output_style`, `effort`, `model_initial`, `model_final`, `fast_mode_state`, `fast_mode_disabled_reason`, `permission_mode_initial`, `permission_mode_final`, `permission_mode_changes`, `analytics_disabled`. Lifecycle: `start_type` (`fresh`/`resume`/`fork`/`clear`/`compact`), `start_source`, `end_reason`, `terminal_reason`, `stop_reason_final`, `outcome` (`completed`/`aborted`/`crashed`/`unknown`), `is_error`, `api_error_status`, `started_at`, `first_prompt_at`, `last_event_at`, `ended_at`, `sealed_at`. Place: `cwd`, `project_dir`, `transcript_path`, `git_remote_digest`, `git_branch`, `git_head_sha_start`, `git_head_sha_end`, `git_dirty_start`, `worktree_path`, `worktree_name`, `worktree_branch`, `relocated_cwd`. Inventory (jsonb, from `system.init` and attachments): `tools_available`, `mcp_servers`, `agents_available`, `skills_available`, `slash_commands`, `plugins`, `harness_capabilities`, `instructions_loaded` (`[{file_path, memory_type, load_reason, digest}]`), `settings_sources` (`[{source, path, digest}]`), `hooks_registered` (`[{event, type, matcher, source}]`), `env_snapshot` (secret-denylisted), `memory_paths`. Totals: `num_turns`, `num_prompts`, `num_model_calls`, `num_api_errors`, `num_api_retries`, `num_tool_calls`, `num_tool_errors`, `num_tool_rejections`, `num_tool_asks`, `num_subagents`, `num_compactions`, `num_model_switches`, `num_notifications`, `num_elicitations`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cache_creation_5m_tokens`, `cache_creation_1h_tokens`, `thinking_tokens`, `web_search_requests`, `web_fetch_requests`, `total_cost_micros`, `cost_basis`, `has_unknown_model_cost`, `duration_ms`, `api_duration_ms`, `api_duration_without_retries_ms`, `tool_duration_ms`, `active_time_s`, `ttft_first_ms`, `lines_added`, `lines_removed`, `files_read`, `files_written`, `files_deleted`, `commands_run`, `network_calls`, `commits`, `pull_requests`, `subagent_stats` jsonb, `permission_denials` jsonb, `models_used` text[]. Policy: `enforcement_tier`, `bundle_mode`, `bundle_version`, `policy_decisions`, `policy_denies`, `elevations_requested`, `elevations_approved`, `elevations_denied`, `elevations_expired`, `tokens_issued`, `tokens_used`. Chain: `seq_count`, `genesis_hash`, `final_hash`, `checkpoint_count`, `last_checkpoint_id`, `chain_verified`, `telemetry_gap_count`, `unobserved_tail`, `completeness_gaps` text[], `replay_grade`, `evidence_manifest_id`. Presentation: `title` (transcript `ai-title`), `last_prompt_digest`. Timestamps.

### 3.3 `tacho_session_models`
`session_id`, `model`, `canonical_model`, `provider`, `cost_basis`, `context_window`, `max_output_tokens`, `requests`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `thinking_tokens`, `web_search_requests`, `cost_micros`, `api_duration_ms`. Unique `(session_id, model)`.

### 3.4 `tacho_session_files`
`session_id`, `path`, `repo_relative_path`, `reads`, `writes`, `edits`, `deletes`, `bytes_written`, `lines_added`, `lines_removed`, `first_seq`, `last_seq`, `digest_before`, `digest_after`, `language`. Unique `(session_id, path)`. This is the lineage seam for Neo4j.

### 3.5 `tacho_session_commands`
`session_id`, `seq`, `tool_use_id`, `command_digest`, `command_head` (512), `bash_command` (OTel `tool_parameters.bash_command`, the first word), `exit_status`, `duration_ms`, `status`, `cwd`, `decision`, `decision_source`, `policy_rule`.

### 3.6 `tacho_control_commands` (`tcmd_`)
`host_enrollment_id`, `session_id` (nullable), `command` (`pause`/`resume`/`cancel`/`message`/`revoke`/`refresh_bundle`/`kill`), `payload` jsonb, `issued_by_principal_id`, `issued_at`, `expires_at`, `delivered_at`, `acknowledged_at`, `applied_at`, `applied_at_seq`, `outcome` (`pending`/`delivered`/`applied`/`expired`/`failed`), `outcome_detail`.

### 3.7 `tacho_incidents` (`tinc_`)
`host_enrollment_id`, `session_id` (nullable), `kind` (`unobserved_session`, `hooks_removed`, `config_change`, `telemetry_gap`, `chain_break`, `checkpoint_lapse`, `token_replay`, `policy_violation`, `spoofed_event`, `daemon_down`, `otel_missing`, `unknown_model_cost`), `severity` (1/3/10), `detected_at`, `detected_by` (`collector`/`control_plane`/`human`), `evidence` jsonb, `event_seq`, `resolved_at`, `resolved_by_principal_id`, `resolution_note`, `trust_weight`.

### 3.8 `tacho_checkpoints` (`tchk_`)
`session_id`, `seq`, `chain_head`, `event_count`, `device_key_fingerprint`, `device_signature`, `platform_key_id`, `platform_signature`, `signed_at`, `countersigned_at`, `anchor_root` (nullable, phase D), `anchored_at`.

## 4. Envelope kinds and their typed bodies

The `tacho/1.0` envelope is unchanged (`spec.md` §6.1). Each `kind` has a zod body in `packages/tacho/src/envelope.ts`; the ClickHouse columns in §2 are exactly the flattening of those bodies plus the envelope scalars, so a body member and a column never disagree by construction (a test flattens every fixture body and asserts the column set).

## 5. What is deliberately not a column

- Raw prompt, tool input, tool output, and response bytes (digested; retained only under policy in blobs).
- Raw hostname, OS user, and absolute home-directory paths in ClickHouse (digested; the Postgres host record keeps the readable `hostname` and `os_user` under RLS).
- The API key source's value or any credential.
- Anything derived by inference (risk scores, trust tiers) — those are computed downstream from these facts and stored with their inputs' digests, per the trust-scoring design.

## 6. Reference-only fields folded in (not exercised by the probe)

These come from the published hook and monitoring references and are modelled now so the day they fire nothing is lost. All land in `tacho_events` unless marked session-level.

| Column | Type | From |
|---|---|---|
| `command_name`, `command_source`, `command_input_digest` | String, LC, String | `UserPromptSubmit`/`UserPromptExpansion` (`command_name`, `command_input`), OTel `user_prompt.command_name/command_source` (`builtin` \| `custom` \| `mcp`) |
| `stop_failure_error_type` | LC | `StopFailure` (`rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `unknown`) |
| `notification_type` | LC | `Notification` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_*`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_*`) |
| `task_name`, `task_id` | String | `TaskCreated` / `TaskCompleted` |
| `cwd_previous`, `cwd_new` | String | `CwdChanged` |
| `directory_added`, `directory_add_method` | String, LC | `DirectoryAdded` (`slash_command` \| `register_repo_root`) |
| `worktree_reason` | LC | `WorktreeCreate` (`background_session` \| `isolation` \| `explicit_flag`) |
| `elicitation_server`, `elicitation_message_type`, `elicitation_prompt_digest`, `elicitation_response_digest` | String, LC, String, String | `Elicitation` / `ElicitationResult` |
| `setup_trigger` | LC | `Setup` (`init` \| `maintenance`) |
| `teammate_name` | String | `TeammateIdle` |
| `refusal_category`, `refusal_has_category`, `refusal_has_explanation`, `server_fallback_hop` | LC, N(Bool), N(Bool), N(Bool) | OTel `api_refusal` |
| `permission_mode_trigger` | LC | OTel `permission_mode_changed.trigger` (`shift_tab`, `exit_plan_mode`, `auto_gate_denied`, `auto_opt_in`) |
| `auth_action`, `auth_success`, `auth_method`, `auth_error_category`, `auth_status_code` | LC, N(Bool), LC, LC, N(UInt16) | OTel `auth` |
| `tool_result_tokens` | N(UInt32) | span `tool.result_tokens` |
| `skill_name`, `plugin_name`, `marketplace_name`, `plugin_id_hash` | String | OTel attribution attrs on `api_request`, `api_error`, `cost.usage`, span `tool.skill_name`, `mcp_server_connection.plugin_id_hash` |
| `workspace_host_paths` | Array(String) | OTel `workspace.host_paths` |
| `workflow_run_id`, `workflow_name` | String | OTel `workflow.*` |
| `api_retry_attempt`, `api_retry_max`, `api_retry_delay_ms`, `api_retry_no_response` | N(UInt8), N(UInt8), N(UInt32), N(Bool) | stream `system.api_retry` |
| `plugin_install_status`, `plugin_install_name` | LC, String | stream `system.plugin_install` |
| `structured_output_digest` | String | result `structured_output` |
| session: `plugin_errors`, `mcp_server_errors` (jsonb), `available_models`, `fallback_models` (text[]), `effort_level_setting`, `sandbox_enabled`, `auto_compact_enabled`, `always_thinking_enabled`, `prompt_cache_ttl`, `default_permission_mode_setting` | — | `system.init` and the effective settings the collector reads at session start |

### Name drift the adapter tolerates

The live 2.1.263 binary and the reference disagree on four hook members. The adapter reads both and records the value once under the column named here:

| Column | Live binary | Reference |
|---|---|---|
| `prompt_digest` source | `UserPromptSubmit.prompt` | `user_input` |
| `hook_source_kind` for session end | `SessionEnd.reason` | `end_reason` |
| `hook_source_kind` for session start | `SessionStart.source` | `trigger` |
| `stop_failure_error_type` | `StopFailure.error` | `error_type` |
