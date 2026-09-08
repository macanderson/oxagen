-- Tacho control plane: hosts, sessions, and control state for agents Oxagen
-- does not run (docs/specs/tacho/spec.md; column contract in
-- docs/specs/tacho/data-model.md section 3). ClickHouse holds every event
-- (packages/telemetry/src/migrations/0027_tacho_events.sql); these tables hold
-- what needs RLS, joins, and indefinite retention.
--
-- Notes:
--   - Table DDL is `drizzle-kit export` output for packages/database/src/schema/tacho.ts,
--     hand-assembled + `atlas migrate hash` because `atlas migrate diff` is broken
--     by the pg_trgm fresh-replay defect
--     (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md).
--   - No cross-schema FK; app-enforced FKs per CLAUDE.md.
--   - RLS follows the tenant_isolation pattern from 20260612140000.
--   - oxagen_app grants are additive + idempotent. session_commands and
--     checkpoints are append-only (SELECT + INSERT): a command a session ran and
--     a signed chain commitment are evidence, not state.
--   - Plain DDL only (RDS-compatible; no superuser-only features).

CREATE SCHEMA IF NOT EXISTS "tacho";

CREATE TABLE "tacho"."hosts" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_key" text NOT NULL,
	"agent_id" uuid,
	"agent_principal_id" uuid,
	"api_key_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"hostname_digest" text NOT NULL,
	"platform" text NOT NULL,
	"os_version" text,
	"arch" text,
	"os_user" text NOT NULL,
	"os_user_digest" text NOT NULL,
	"device_public_key" text NOT NULL,
	"device_key_fingerprint" text NOT NULL,
	"harnesses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claude_version_at_enroll" text,
	"claude_execpath" text,
	"node_version" text,
	"wrapper_version" text,
	"shell" text,
	"terminal_type_last" text,
	"status" text DEFAULT 'active' NOT NULL,
	"enrollment_claims" jsonb NOT NULL,
	"enrollment_signature" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"managed" boolean DEFAULT false NOT NULL,
	"managed_settings_digest" text,
	"user_settings_digest" text,
	"project_settings_digests" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mode" text DEFAULT 'observe' NOT NULL,
	"bundle_version_served" integer,
	"bundle_etag_served" text,
	"deny_generation_org_seen" bigint,
	"deny_generation_ws_seen" bigint,
	"last_bundle_fetch_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_ingest_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"spool_depth" integer DEFAULT 0 NOT NULL,
	"spool_oldest_at" timestamp with time zone,
	"hooks_ok" boolean,
	"hooks_last_checked_at" timestamp with time zone,
	"otel_ok" boolean,
	"daemon_version" text,
	"daemon_uptime_s" integer,
	"sessions_count" integer DEFAULT 0 NOT NULL,
	"unobserved_sessions_count" integer DEFAULT 0 NOT NULL,
	"incidents_open" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "hosts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tacho_hosts_status_check" CHECK ("tacho"."hosts"."status" IN ('active', 'paused', 'suspended', 'revoked')),
	CONSTRAINT "tacho_hosts_mode_check" CHECK ("tacho"."hosts"."mode" IN ('observe', 'enforce')),
	CONSTRAINT "tacho_hosts_platform_check" CHECK ("tacho"."hosts"."platform" IN ('darwin', 'linux', 'win32')),
	CONSTRAINT "tacho_hosts_revoked_check" CHECK (("tacho"."hosts"."status" = 'revoked') = ("tacho"."hosts"."revoked_at" IS NOT NULL))
);

CREATE TABLE "tacho"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_uuid" uuid NOT NULL,
	"harness_session_id" text NOT NULL,
	"host_id" uuid,
	"agent_key" text NOT NULL,
	"agent_id" uuid,
	"agent_principal_id" uuid,
	"initiating_principal_id" uuid,
	"initiating_user_id" uuid,
	"root_session_uuid" uuid NOT NULL,
	"parent_session_uuid" uuid,
	"subagent_id" text,
	"subagent_type" text,
	"subagent_description" text,
	"spawn_depth" smallint DEFAULT 0 NOT NULL,
	"spawn_tool_use_id" text,
	"anthropic_user_id_hash" text,
	"anthropic_user_email" text,
	"anthropic_account_uuid" text,
	"anthropic_account_id" text,
	"anthropic_org_uuid" text,
	"api_key_source" text,
	"runtime" text NOT NULL,
	"harness" text NOT NULL,
	"harness_version" text,
	"wrapper_version" text,
	"entrypoint" text,
	"query_source_initial" text,
	"terminal_type" text,
	"session_kind" text,
	"is_child_session" boolean,
	"bridge_session_id" text,
	"output_style" text,
	"effort" text,
	"model_initial" text,
	"model_final" text,
	"fast_mode_state" text,
	"fast_mode_disabled_reason" text,
	"permission_mode_initial" text,
	"permission_mode_final" text,
	"permission_mode_changes" integer DEFAULT 0 NOT NULL,
	"analytics_disabled" boolean,
	"start_type" text,
	"start_source" text,
	"end_reason" text,
	"terminal_reason" text,
	"stop_reason_final" text,
	"outcome" text DEFAULT 'running' NOT NULL,
	"is_error" boolean,
	"api_error_status" integer,
	"started_at" timestamp with time zone NOT NULL,
	"first_prompt_at" timestamp with time zone,
	"last_event_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"sealed_at" timestamp with time zone,
	"cwd" text,
	"project_dir" text,
	"transcript_path" text,
	"git_remote_digest" text,
	"git_branch" text,
	"git_head_sha_start" text,
	"git_head_sha_end" text,
	"git_dirty_start" boolean,
	"worktree_path" text,
	"worktree_name" text,
	"worktree_branch" text,
	"relocated_cwd" text,
	"tools_available" jsonb,
	"mcp_servers" jsonb,
	"agents_available" jsonb,
	"skills_available" jsonb,
	"slash_commands" jsonb,
	"plugins" jsonb,
	"plugin_errors" jsonb,
	"mcp_server_errors" jsonb,
	"harness_capabilities" jsonb,
	"instructions_loaded" jsonb,
	"settings_sources" jsonb,
	"hooks_registered" jsonb,
	"env_snapshot" jsonb,
	"memory_paths" jsonb,
	"available_models" jsonb,
	"fallback_models" jsonb,
	"effort_level_setting" text,
	"sandbox_enabled" boolean,
	"auto_compact_enabled" boolean,
	"always_thinking_enabled" boolean,
	"prompt_cache_ttl" text,
	"default_permission_mode_setting" text,
	"num_turns" integer DEFAULT 0 NOT NULL,
	"num_prompts" integer DEFAULT 0 NOT NULL,
	"num_model_calls" integer DEFAULT 0 NOT NULL,
	"num_api_errors" integer DEFAULT 0 NOT NULL,
	"num_api_retries" integer DEFAULT 0 NOT NULL,
	"num_tool_calls" integer DEFAULT 0 NOT NULL,
	"num_tool_errors" integer DEFAULT 0 NOT NULL,
	"num_tool_rejections" integer DEFAULT 0 NOT NULL,
	"num_tool_asks" integer DEFAULT 0 NOT NULL,
	"num_subagents" integer DEFAULT 0 NOT NULL,
	"num_compactions" integer DEFAULT 0 NOT NULL,
	"num_model_switches" integer DEFAULT 0 NOT NULL,
	"num_notifications" integer DEFAULT 0 NOT NULL,
	"num_elicitations" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_5m_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_1h_tokens" bigint DEFAULT 0 NOT NULL,
	"thinking_tokens" bigint DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"web_fetch_requests" integer DEFAULT 0 NOT NULL,
	"total_cost_micros" bigint DEFAULT 0 NOT NULL,
	"cost_basis" text,
	"has_unknown_model_cost" boolean,
	"duration_ms" integer,
	"api_duration_ms" integer,
	"api_duration_without_retries_ms" integer,
	"tool_duration_ms" integer,
	"active_time_s" integer,
	"ttft_first_ms" integer,
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_removed" integer DEFAULT 0 NOT NULL,
	"files_read" integer DEFAULT 0 NOT NULL,
	"files_written" integer DEFAULT 0 NOT NULL,
	"files_deleted" integer DEFAULT 0 NOT NULL,
	"commands_run" integer DEFAULT 0 NOT NULL,
	"network_calls" integer DEFAULT 0 NOT NULL,
	"commits" integer DEFAULT 0 NOT NULL,
	"pull_requests" integer DEFAULT 0 NOT NULL,
	"subagent_stats" jsonb,
	"permission_denials" jsonb,
	"models_used" jsonb,
	"enforcement_tier" text DEFAULT 'observe' NOT NULL,
	"bundle_mode" text,
	"bundle_version" integer,
	"policy_decisions" integer DEFAULT 0 NOT NULL,
	"policy_denies" integer DEFAULT 0 NOT NULL,
	"elevations_requested" integer DEFAULT 0 NOT NULL,
	"elevations_approved" integer DEFAULT 0 NOT NULL,
	"elevations_denied" integer DEFAULT 0 NOT NULL,
	"elevations_expired" integer DEFAULT 0 NOT NULL,
	"tokens_issued" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"seq_count" bigint DEFAULT 0 NOT NULL,
	"genesis_hash" text,
	"last_hash" text,
	"final_hash" text,
	"checkpoint_count" integer DEFAULT 0 NOT NULL,
	"last_checkpoint_id" uuid,
	"chain_verified" boolean DEFAULT true NOT NULL,
	"chain_break_at_seq" bigint,
	"telemetry_gap_count" integer DEFAULT 0 NOT NULL,
	"unobserved_tail" boolean DEFAULT false NOT NULL,
	"completeness_gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replay_grade" text,
	"evidence_manifest_id" uuid,
	"title" text,
	"last_prompt_digest" text,
	CONSTRAINT "sessions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tacho_sessions_outcome_check" CHECK ("tacho"."sessions"."outcome" IN ('running', 'completed', 'aborted', 'crashed', 'unknown')),
	CONSTRAINT "tacho_sessions_runtime_check" CHECK ("tacho"."sessions"."runtime" IN ('claude-code', 'claude-agent-sdk', 'custom', 'stella', 'proxy')),
	CONSTRAINT "tacho_sessions_tier_check" CHECK ("tacho"."sessions"."enforcement_tier" IN ('gateway', 'harness', 'observe')),
	CONSTRAINT "tacho_sessions_hash_check" CHECK (("tacho"."sessions"."last_hash" IS NULL OR "tacho"."sessions"."last_hash" ~ '^sha256:[0-9a-f]{64}$') AND ("tacho"."sessions"."final_hash" IS NULL OR "tacho"."sessions"."final_hash" ~ '^sha256:[0-9a-f]{64}$'))
);

CREATE TABLE "tacho"."session_models" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"model" text NOT NULL,
	"canonical_model" text,
	"provider" text,
	"cost_basis" text,
	"context_window" integer,
	"max_output_tokens" integer,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
	"thinking_tokens" bigint DEFAULT 0 NOT NULL,
	"web_search_requests" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"api_duration_ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "session_models_public_id_unique" UNIQUE("public_id")
);

CREATE TABLE "tacho"."session_files" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"path" text NOT NULL,
	"repo_relative_path" text,
	"language" text,
	"reads" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	"edits" integer DEFAULT 0 NOT NULL,
	"deletes" integer DEFAULT 0 NOT NULL,
	"bytes_written" bigint DEFAULT 0 NOT NULL,
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_removed" integer DEFAULT 0 NOT NULL,
	"first_seq" bigint NOT NULL,
	"last_seq" bigint NOT NULL,
	"digest_before" text,
	"digest_after" text,
	CONSTRAINT "session_files_public_id_unique" UNIQUE("public_id")
);

CREATE TABLE "tacho"."session_commands" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"tool_use_id" text,
	"command_digest" text NOT NULL,
	"command_head" text NOT NULL,
	"bash_command" text,
	"exit_status" integer,
	"duration_ms" integer,
	"status" text,
	"cwd" text,
	"decision" text,
	"decision_source" text,
	"policy_rule" text,
	CONSTRAINT "session_commands_public_id_unique" UNIQUE("public_id")
);

CREATE TABLE "tacho"."control_commands" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"session_id" uuid,
	"command" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"issued_by_principal_id" uuid,
	"issued_by_user_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"applied_at_seq" bigint,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"outcome_detail" text,
	CONSTRAINT "control_commands_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tacho_control_commands_command_check" CHECK ("tacho"."control_commands"."command" IN ('pause', 'resume', 'cancel', 'message', 'revoke', 'refresh_bundle', 'kill')),
	CONSTRAINT "tacho_control_commands_outcome_check" CHECK ("tacho"."control_commands"."outcome" IN ('pending', 'delivered', 'applied', 'expired', 'failed'))
);

CREATE TABLE "tacho"."incidents" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"host_id" uuid,
	"session_id" uuid,
	"kind" text NOT NULL,
	"severity" smallint NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detected_by" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_seq" bigint,
	"resolved_at" timestamp with time zone,
	"resolved_by_principal_id" uuid,
	"resolution_note" text,
	"trust_weight" integer,
	CONSTRAINT "incidents_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tacho_incidents_kind_check" CHECK ("tacho"."incidents"."kind" IN ('unobserved_session', 'hooks_removed', 'config_change', 'telemetry_gap', 'chain_break', 'checkpoint_lapse', 'token_replay', 'policy_violation', 'spoofed_event', 'daemon_down', 'otel_missing', 'unknown_model_cost')),
	CONSTRAINT "tacho_incidents_severity_check" CHECK ("tacho"."incidents"."severity" IN (1, 3, 10)),
	CONSTRAINT "tacho_incidents_detected_by_check" CHECK ("tacho"."incidents"."detected_by" IN ('collector', 'control_plane', 'human'))
);

CREATE TABLE "tacho"."checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"chain_head" text NOT NULL,
	"event_count" bigint NOT NULL,
	"device_key_fingerprint" text NOT NULL,
	"device_signature" text NOT NULL,
	"platform_key_id" text,
	"platform_signature" text,
	"signed_at" timestamp with time zone NOT NULL,
	"countersigned_at" timestamp with time zone,
	"anchor_root" text,
	"anchored_at" timestamp with time zone,
	CONSTRAINT "checkpoints_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tacho_checkpoints_head_check" CHECK ("tacho"."checkpoints"."chain_head" ~ '^sha256:[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "tacho_checkpoints_uniq" ON "tacho"."checkpoints" USING btree ("session_id","seq");
CREATE INDEX "tacho_checkpoints_org_idx" ON "tacho"."checkpoints" USING btree ("org_id","workspace_id");
CREATE INDEX "tacho_control_commands_host_pending_idx" ON "tacho"."control_commands" USING btree ("host_id","outcome","issued_at");
CREATE INDEX "tacho_control_commands_org_idx" ON "tacho"."control_commands" USING btree ("org_id","workspace_id");
CREATE INDEX "tacho_hosts_org_idx" ON "tacho"."hosts" USING btree ("org_id","workspace_id");
CREATE UNIQUE INDEX "tacho_hosts_api_key_uniq" ON "tacho"."hosts" USING btree ("api_key_id");
CREATE UNIQUE INDEX "tacho_hosts_agent_key_uniq" ON "tacho"."hosts" USING btree ("org_id","agent_key");
CREATE INDEX "tacho_incidents_host_open_idx" ON "tacho"."incidents" USING btree ("host_id","resolved_at");
CREATE INDEX "tacho_incidents_org_idx" ON "tacho"."incidents" USING btree ("org_id","workspace_id","detected_at");
CREATE UNIQUE INDEX "tacho_session_commands_uniq" ON "tacho"."session_commands" USING btree ("session_id","seq");
CREATE INDEX "tacho_session_commands_org_idx" ON "tacho"."session_commands" USING btree ("org_id","workspace_id");
CREATE UNIQUE INDEX "tacho_session_files_uniq" ON "tacho"."session_files" USING btree ("session_id","path");
CREATE INDEX "tacho_session_files_org_idx" ON "tacho"."session_files" USING btree ("org_id","workspace_id");
CREATE UNIQUE INDEX "tacho_session_models_uniq" ON "tacho"."session_models" USING btree ("session_id","model");
CREATE INDEX "tacho_session_models_org_idx" ON "tacho"."session_models" USING btree ("org_id","workspace_id");
CREATE UNIQUE INDEX "tacho_sessions_session_uuid_uniq" ON "tacho"."sessions" USING btree ("session_uuid");
CREATE INDEX "tacho_sessions_org_idx" ON "tacho"."sessions" USING btree ("org_id","workspace_id","started_at");
CREATE INDEX "tacho_sessions_host_idx" ON "tacho"."sessions" USING btree ("host_id","started_at");
CREATE INDEX "tacho_sessions_root_idx" ON "tacho"."sessions" USING btree ("root_session_uuid");

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
-- Pattern matches 20260612140000_restore_rls_policies.sql exactly.
ALTER TABLE tacho.hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.hosts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.hosts;
CREATE POLICY tenant_isolation ON tacho.hosts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tacho.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.sessions;
CREATE POLICY tenant_isolation ON tacho.sessions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tacho.session_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.session_models FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.session_models;
CREATE POLICY tenant_isolation ON tacho.session_models
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tacho.session_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.session_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.session_files;
CREATE POLICY tenant_isolation ON tacho.session_files
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tacho.session_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.session_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.session_commands;
CREATE POLICY tenant_isolation ON tacho.session_commands
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tacho.control_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.control_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.control_commands;
CREATE POLICY tenant_isolation ON tacho.control_commands
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tacho.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.incidents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.incidents;
CREATE POLICY tenant_isolation ON tacho.incidents
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tacho.checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.checkpoints;
CREATE POLICY tenant_isolation ON tacho.checkpoints
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA tacho TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.hosts TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.sessions TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.session_models TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.session_files TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON tacho.session_commands TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.control_commands TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.incidents TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON tacho.checkpoints TO oxagen_app';
  END IF;
END
$$;
