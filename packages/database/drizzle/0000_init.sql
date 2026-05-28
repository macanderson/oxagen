-- Foundations initial migration. Hand-written per spec §10.
-- Idempotent where possible; designed to run once on an empty database.

------------------------------------------------------------
-- Extensions
------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "ltree";

-- pg_uuidv7 may not be installed; install if available, otherwise we fall
-- back to uuid_generate_v4 inside the COALESCE default declared in
-- _mixins.ts. Production deployments should ship with pg_uuidv7.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS "pg_uuidv7"';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_uuidv7 unavailable; falling back to uuid_generate_v4';
  END;
END $$;

------------------------------------------------------------
-- Schemas (spec §6)
------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS "auth";
CREATE SCHEMA IF NOT EXISTS "organization";
CREATE SCHEMA IF NOT EXISTS "workspace";
CREATE SCHEMA IF NOT EXISTS "integration";
CREATE SCHEMA IF NOT EXISTS "agent";
CREATE SCHEMA IF NOT EXISTS "workflow";
CREATE SCHEMA IF NOT EXISTS "event";
CREATE SCHEMA IF NOT EXISTS "execution";
CREATE SCHEMA IF NOT EXISTS "chat";
CREATE SCHEMA IF NOT EXISTS "content";
CREATE SCHEMA IF NOT EXISTS "graph";
CREATE SCHEMA IF NOT EXISTS "evaluation";
CREATE SCHEMA IF NOT EXISTS "billing";

------------------------------------------------------------
-- organization
------------------------------------------------------------

CREATE TABLE "organization"."tenants" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "name" text NOT NULL,
  "slug" citext NOT NULL,
  "plan_type" text NOT NULL,
  "status" text NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX "tenants_slug_idx" ON "organization"."tenants" ("slug");
CREATE INDEX "tenants_status_idx" ON "organization"."tenants" ("status");

CREATE TABLE "organization"."tenant_users" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "permissions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "joined_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "tenant_users_tenant_user_idx" ON "organization"."tenant_users" ("tenant_id", "user_id");
CREATE INDEX "tenant_users_user_idx" ON "organization"."tenant_users" ("user_id");

CREATE TABLE "organization"."tenant_slug_history" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id") ON DELETE CASCADE,
  "old_slug" citext NOT NULL,
  "new_slug" citext NOT NULL,
  "changed_at" timestamptz NOT NULL,
  "redirect_enabled" boolean NOT NULL DEFAULT true
);
CREATE INDEX "tenant_slug_history_old_slug_idx" ON "organization"."tenant_slug_history" ("old_slug");
CREATE INDEX "tenant_slug_history_tenant_idx" ON "organization"."tenant_slug_history" ("tenant_id");

------------------------------------------------------------
-- auth
------------------------------------------------------------

CREATE TABLE "auth"."users" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "email" citext NOT NULL,
  "username" citext,
  "display_name" text,
  "avatar_url" text,
  "status" text NOT NULL,
  "email_verified_at" timestamptz,
  "last_login_at" timestamptz
);
CREATE UNIQUE INDEX "users_email_idx" ON "auth"."users" ("email");
CREATE UNIQUE INDEX "users_username_idx" ON "auth"."users" ("username");

CREATE TABLE "auth"."credentials" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "provider" text NOT NULL,
  "credential_type" text NOT NULL,
  "encrypted_payload" bytea NOT NULL,
  "kms_key_id" text,
  "expires_at" timestamptz,
  "last_used_at" timestamptz
);
CREATE INDEX "credentials_tenant_idx" ON "auth"."credentials" ("tenant_id", "workspace_id");
CREATE INDEX "credentials_provider_idx" ON "auth"."credentials" ("tenant_id", "provider");

CREATE TABLE "auth"."api_keys" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "key_prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "name" text NOT NULL,
  "scope" jsonb NOT NULL,
  "expires_at" timestamptz,
  "last_used_at" timestamptz
);
CREATE UNIQUE INDEX "api_keys_key_prefix_idx" ON "auth"."api_keys" ("key_prefix");
CREATE INDEX "api_keys_tenant_idx" ON "auth"."api_keys" ("tenant_id", "workspace_id");

-- Better Auth (spec §15.4) — own ID convention.
CREATE TABLE "auth"."sessions" (
  "id" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "sessions_token_idx" ON "auth"."sessions" ("token");
CREATE INDEX "sessions_user_idx" ON "auth"."sessions" ("user_id");
CREATE INDEX "sessions_expires_idx" ON "auth"."sessions" ("expires_at");

CREATE TABLE "auth"."accounts" (
  "id" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "auth"."users"("id") ON DELETE CASCADE,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "auth"."accounts" ("provider_id", "account_id");
CREATE INDEX "accounts_user_idx" ON "auth"."accounts" ("user_id");

CREATE TABLE "auth"."verifications" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "verifications_identifier_idx" ON "auth"."verifications" ("identifier");

------------------------------------------------------------
-- workspace
------------------------------------------------------------

CREATE TABLE "workspace"."workspaces" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" citext NOT NULL,
  "default_graph_id" uuid,
  "settings" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX "workspaces_tenant_slug_idx" ON "workspace"."workspaces" ("tenant_id", "slug");
CREATE INDEX "workspaces_tenant_idx" ON "workspace"."workspaces" ("tenant_id");

CREATE TABLE "workspace"."workspace_users" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"."workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "permissions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "joined_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "workspace_users_workspace_user_idx" ON "workspace"."workspace_users" ("workspace_id", "user_id");
CREATE INDEX "workspace_users_user_idx" ON "workspace"."workspace_users" ("user_id");

CREATE TABLE "workspace"."folders" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "parent_folder_id" uuid REFERENCES "workspace"."folders"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "path" ltree NOT NULL
);
CREATE INDEX "folders_tenant_idx" ON "workspace"."folders" ("tenant_id", "workspace_id");
-- GIST index supports ltree subtree containment ops (<@, @>).
CREATE INDEX "folders_path_idx" ON "workspace"."folders" USING gist ("path");

CREATE TABLE "workspace"."workspace_slug_history" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "workspace_id" uuid NOT NULL REFERENCES "workspace"."workspaces"("id") ON DELETE CASCADE,
  "old_slug" citext NOT NULL,
  "new_slug" citext NOT NULL,
  "changed_at" timestamptz NOT NULL,
  "redirect_enabled" boolean NOT NULL DEFAULT true
);
CREATE INDEX "workspace_slug_history_old_slug_idx" ON "workspace"."workspace_slug_history" ("workspace_id", "old_slug");

------------------------------------------------------------
-- integration
------------------------------------------------------------

CREATE TABLE "integration"."connections" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "provider" text NOT NULL,
  "display_name" text NOT NULL,
  "credential_id" uuid,
  "status" text NOT NULL,
  "sync_enabled" boolean NOT NULL DEFAULT true,
  "last_sync_at" timestamptz,
  "config" jsonb NOT NULL
);
CREATE INDEX "connections_tenant_idx" ON "integration"."connections" ("tenant_id", "workspace_id");
CREATE INDEX "connections_provider_idx" ON "integration"."connections" ("tenant_id", "provider");

CREATE TABLE "integration"."connection_sync_jobs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('pending','queued','running','completed','failed','cancelled','timed_out')),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "cancelled_at" timestamptz,
  "connection_id" uuid NOT NULL REFERENCES "integration"."connections"("id") ON DELETE CASCADE,
  "started_cursor" text,
  "completed_cursor" text,
  "records_processed" bigint NOT NULL DEFAULT 0,
  "error_payload" jsonb
);
CREATE INDEX "connection_sync_jobs_connection_idx" ON "integration"."connection_sync_jobs" ("connection_id");
CREATE INDEX "connection_sync_jobs_status_idx" ON "integration"."connection_sync_jobs" ("status");

------------------------------------------------------------
-- agent
------------------------------------------------------------

CREATE TABLE "agent"."agents" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "name" text NOT NULL,
  "slug" citext NOT NULL,
  "description" text,
  "default_model" text NOT NULL,
  "is_system_agent" boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "agents_tenant_slug_idx" ON "agent"."agents" ("tenant_id", "slug");
CREATE INDEX "agents_tenant_idx" ON "agent"."agents" ("tenant_id", "workspace_id");

CREATE TABLE "agent"."agent_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid REFERENCES "agent"."agent_versions"("id"),
  "published_at" timestamptz,
  "input_schema" jsonb NOT NULL,
  "output_schema" jsonb NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "agent_id" uuid NOT NULL REFERENCES "agent"."agents"("id") ON DELETE CASCADE,
  "system_prompt" text NOT NULL,
  "model" text NOT NULL,
  "temperature" numeric(3,2) NOT NULL,
  "context_window" integer,
  "tool_choice_policy" text NOT NULL,
  "runtime_config" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX "agent_versions_agent_idx" ON "agent"."agent_versions" ("agent_id");
CREATE UNIQUE INDEX "agent_versions_agent_latest_idx" ON "agent"."agent_versions" ("agent_id") WHERE "is_latest" = true;
CREATE UNIQUE INDEX "agent_versions_agent_version_idx" ON "agent"."agent_versions" ("agent_id", "version_number");
CREATE INDEX "agent_versions_tenant_idx" ON "agent"."agent_versions" ("tenant_id", "workspace_id");

CREATE TABLE "agent"."tools" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" citext NOT NULL,
  "tool_type" text NOT NULL,
  "description" text NOT NULL,
  "is_enabled" boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "tools_tenant_slug_idx" ON "agent"."tools" ("tenant_id", "slug");
CREATE INDEX "tools_tenant_idx" ON "agent"."tools" ("tenant_id", "workspace_id");

CREATE TABLE "agent"."tool_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid REFERENCES "agent"."tool_versions"("id"),
  "published_at" timestamptz,
  "tool_id" uuid NOT NULL REFERENCES "agent"."tools"("id") ON DELETE CASCADE,
  "input_schema" jsonb NOT NULL,
  "output_schema" jsonb NOT NULL,
  "runtime_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "execution_handler" text NOT NULL,
  "execution_mode" text NOT NULL,
  "timeout_seconds" integer NOT NULL
);
CREATE INDEX "tool_versions_tool_idx" ON "agent"."tool_versions" ("tool_id");
CREATE UNIQUE INDEX "tool_versions_tool_latest_idx" ON "agent"."tool_versions" ("tool_id") WHERE "is_latest" = true;
CREATE UNIQUE INDEX "tool_versions_tool_version_idx" ON "agent"."tool_versions" ("tool_id", "version_number");

CREATE TABLE "agent"."tool_assignments" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "agent_version_id" uuid NOT NULL REFERENCES "agent"."agent_versions"("id") ON DELETE CASCADE,
  "tool_version_id" uuid NOT NULL REFERENCES "agent"."tool_versions"("id") ON DELETE CASCADE,
  "policy_config" jsonb NOT NULL
);
CREATE INDEX "tool_assignments_agent_version_idx" ON "agent"."tool_assignments" ("agent_version_id");
CREATE INDEX "tool_assignments_tool_version_idx" ON "agent"."tool_assignments" ("tool_version_id");
CREATE UNIQUE INDEX "tool_assignments_pair_idx" ON "agent"."tool_assignments" ("agent_version_id", "tool_version_id");

CREATE TABLE "agent"."mcp_servers" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "transport_type" text NOT NULL,
  "endpoint_url" text NOT NULL,
  "auth_strategy" text NOT NULL,
  "health_status" text NOT NULL,
  "last_healthcheck_at" timestamptz
);
CREATE INDEX "mcp_servers_tenant_idx" ON "agent"."mcp_servers" ("tenant_id", "workspace_id");

------------------------------------------------------------
-- workflow
------------------------------------------------------------

CREATE TABLE "workflow"."playbooks" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "name" text NOT NULL,
  "slug" citext NOT NULL,
  "description" text
);
CREATE UNIQUE INDEX "playbooks_tenant_slug_idx" ON "workflow"."playbooks" ("tenant_id", "slug");
CREATE INDEX "playbooks_tenant_idx" ON "workflow"."playbooks" ("tenant_id", "workspace_id");

CREATE TABLE "workflow"."playbook_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid REFERENCES "workflow"."playbook_versions"("id"),
  "published_at" timestamptz,
  "playbook_id" uuid NOT NULL REFERENCES "workflow"."playbooks"("id") ON DELETE CASCADE,
  "entry_step_id" uuid,
  "graph_definition" jsonb NOT NULL,
  "is_active" boolean NOT NULL DEFAULT false
);
CREATE INDEX "playbook_versions_playbook_idx" ON "workflow"."playbook_versions" ("playbook_id");
CREATE UNIQUE INDEX "playbook_versions_playbook_latest_idx" ON "workflow"."playbook_versions" ("playbook_id") WHERE "is_latest" = true;
CREATE UNIQUE INDEX "playbook_versions_playbook_version_idx" ON "workflow"."playbook_versions" ("playbook_id", "version_number");

CREATE TABLE "workflow"."prompt_templates" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" citext NOT NULL
);
CREATE UNIQUE INDEX "prompt_templates_tenant_slug_idx" ON "workflow"."prompt_templates" ("tenant_id", "slug");
CREATE INDEX "prompt_templates_tenant_idx" ON "workflow"."prompt_templates" ("tenant_id", "workspace_id");

CREATE TABLE "workflow"."prompt_template_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid REFERENCES "workflow"."prompt_template_versions"("id"),
  "published_at" timestamptz,
  "prompt_template_id" uuid NOT NULL REFERENCES "workflow"."prompt_templates"("id") ON DELETE CASCADE,
  "system_prompt" text NOT NULL,
  "user_prompt" text NOT NULL,
  "template_variables" jsonb NOT NULL
);
CREATE INDEX "prompt_template_versions_template_idx" ON "workflow"."prompt_template_versions" ("prompt_template_id");
CREATE UNIQUE INDEX "prompt_template_versions_template_latest_idx" ON "workflow"."prompt_template_versions" ("prompt_template_id") WHERE "is_latest" = true;
CREATE UNIQUE INDEX "prompt_template_versions_template_version_idx" ON "workflow"."prompt_template_versions" ("prompt_template_id", "version_number");

CREATE TABLE "workflow"."playbook_steps" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "input_schema" jsonb NOT NULL,
  "output_schema" jsonb NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "playbook_version_id" uuid NOT NULL REFERENCES "workflow"."playbook_versions"("id") ON DELETE CASCADE,
  "step_key" text NOT NULL,
  "step_type" text NOT NULL,
  "prompt_template_id" uuid REFERENCES "workflow"."prompt_templates"("id"),
  "execution_order" integer,
  "retry_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "timeout_policy" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX "playbook_steps_version_idx" ON "workflow"."playbook_steps" ("playbook_version_id");
CREATE UNIQUE INDEX "playbook_steps_version_key_idx" ON "workflow"."playbook_steps" ("playbook_version_id", "step_key");

CREATE TABLE "workflow"."playbook_step_assignments" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "playbook_step_id" uuid NOT NULL REFERENCES "workflow"."playbook_steps"("id") ON DELETE CASCADE,
  "agent_version_id" uuid NOT NULL,
  "model_override" text,
  "max_retries" integer NOT NULL DEFAULT 0,
  "timeout_seconds" integer
);
CREATE INDEX "playbook_step_assignments_step_idx" ON "workflow"."playbook_step_assignments" ("playbook_step_id");
CREATE INDEX "playbook_step_assignments_agent_version_idx" ON "workflow"."playbook_step_assignments" ("agent_version_id");

------------------------------------------------------------
-- event
------------------------------------------------------------

CREATE TABLE "event"."triggers" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "event_type" text NOT NULL,
  "filter_expression" jsonb NOT NULL,
  "is_enabled" boolean NOT NULL DEFAULT true
);
CREATE INDEX "triggers_tenant_idx" ON "event"."triggers" ("tenant_id", "workspace_id");
CREATE INDEX "triggers_event_type_idx" ON "event"."triggers" ("tenant_id", "event_type");

CREATE TABLE "event"."workflow_triggers" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "trigger_id" uuid NOT NULL REFERENCES "event"."triggers"("id") ON DELETE CASCADE,
  "playbook_version_id" uuid NOT NULL
);
CREATE INDEX "workflow_triggers_trigger_idx" ON "event"."workflow_triggers" ("trigger_id");
CREATE INDEX "workflow_triggers_playbook_version_idx" ON "event"."workflow_triggers" ("playbook_version_id");
CREATE UNIQUE INDEX "workflow_triggers_pair_idx" ON "event"."workflow_triggers" ("trigger_id", "playbook_version_id");

------------------------------------------------------------
-- execution
------------------------------------------------------------

CREATE TABLE "execution"."executions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('pending','queued','running','completed','failed','cancelled','timed_out')),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "cancelled_at" timestamptz,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "playbook_version_id" uuid NOT NULL,
  "trigger_event_id" uuid,
  "triggered_by_message_id" uuid,
  "started_by_user_id" uuid,
  "input_payload" jsonb NOT NULL,
  "output_payload" jsonb,
  "failure_reason" text,
  -- Spec §6.8: chat-initiated and event-triggered executions are mutually
  -- exclusive trigger sources. Enforced here, not in app code.
  CONSTRAINT "executions_one_trigger_source"
    CHECK (NOT ("trigger_event_id" IS NOT NULL AND "triggered_by_message_id" IS NOT NULL))
);
CREATE INDEX "executions_tenant_idx" ON "execution"."executions" ("tenant_id", "workspace_id");
CREATE INDEX "executions_status_idx" ON "execution"."executions" ("status");
CREATE INDEX "executions_started_at_idx" ON "execution"."executions" ("started_at");
CREATE INDEX "executions_playbook_version_idx" ON "execution"."executions" ("playbook_version_id");
CREATE INDEX "executions_triggered_by_message_idx" ON "execution"."executions" ("triggered_by_message_id");

CREATE TABLE "execution"."execution_steps" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('pending','queued','running','completed','failed','cancelled','timed_out')),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "cancelled_at" timestamptz,
  "execution_id" uuid NOT NULL REFERENCES "execution"."executions"("id") ON DELETE CASCADE,
  "playbook_step_id" uuid NOT NULL,
  "agent_version_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL DEFAULT 1,
  "input_payload" jsonb NOT NULL,
  "output_payload" jsonb,
  "token_usage" jsonb,
  "latency_ms" bigint,
  "failure_reason" text
);
CREATE INDEX "execution_steps_execution_idx" ON "execution"."execution_steps" ("execution_id");
CREATE INDEX "execution_steps_status_idx" ON "execution"."execution_steps" ("status");
CREATE INDEX "execution_steps_started_at_idx" ON "execution"."execution_steps" ("started_at");
CREATE INDEX "execution_steps_step_idx" ON "execution"."execution_steps" ("playbook_step_id");

CREATE TABLE "execution"."tool_calls" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "execution_step_id" uuid NOT NULL REFERENCES "execution"."execution_steps"("id") ON DELETE CASCADE,
  "tool_version_id" uuid NOT NULL,
  "request_payload" jsonb NOT NULL,
  "response_payload" jsonb,
  "latency_ms" bigint,
  "token_usage" jsonb,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "tool_calls_step_idx" ON "execution"."tool_calls" ("execution_step_id");
CREATE INDEX "tool_calls_tool_version_idx" ON "execution"."tool_calls" ("tool_version_id");
CREATE INDEX "tool_calls_status_idx" ON "execution"."tool_calls" ("status");

CREATE TABLE "execution"."execution_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "execution_id" uuid NOT NULL REFERENCES "execution"."executions"("id") ON DELETE CASCADE,
  "artifact_type" text NOT NULL,
  "document_id" uuid,
  "storage_uri" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX "execution_artifacts_execution_idx" ON "execution"."execution_artifacts" ("execution_id");
CREATE INDEX "execution_artifacts_tenant_idx" ON "execution"."execution_artifacts" ("tenant_id", "workspace_id");
CREATE INDEX "execution_artifacts_document_idx" ON "execution"."execution_artifacts" ("document_id");

------------------------------------------------------------
-- chat
------------------------------------------------------------

CREATE TABLE "chat"."conversations" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_version_id" uuid,
  "title" text,
  "status" text NOT NULL,
  "active_leaf_message_id" uuid
);
CREATE INDEX "conversations_tenant_idx" ON "chat"."conversations" ("tenant_id", "workspace_id");
CREATE INDEX "conversations_user_idx" ON "chat"."conversations" ("user_id");

CREATE TABLE "chat"."messages" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "chat"."conversations"("id") ON DELETE CASCADE,
  "parent_message_id" uuid REFERENCES "chat"."messages"("id"),
  "role" text NOT NULL,
  "content" text NOT NULL,
  "content_blocks" jsonb NOT NULL,
  "branch_reason" text,
  "is_active_in_branch" boolean NOT NULL DEFAULT true,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- Spec §6.9: walk-up traversal from leaf → root needs this composite.
CREATE INDEX "messages_conversation_parent_idx" ON "chat"."messages" ("conversation_id", "parent_message_id");
CREATE INDEX "messages_tenant_idx" ON "chat"."messages" ("tenant_id", "workspace_id");

------------------------------------------------------------
-- content
------------------------------------------------------------

CREATE TABLE "content"."files" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "storage_provider" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "storage_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "checksum_sha256" text NOT NULL,
  "uploaded_at" timestamptz NOT NULL
);
CREATE UNIQUE INDEX "files_storage_idx" ON "content"."files" ("storage_provider", "storage_bucket", "storage_key");
CREATE INDEX "files_tenant_idx" ON "content"."files" ("tenant_id", "workspace_id");
CREATE INDEX "files_checksum_idx" ON "content"."files" ("tenant_id", "checksum_sha256");

CREATE TABLE "content"."documents" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "file_id" uuid NOT NULL REFERENCES "content"."files"("id"),
  "folder_id" uuid,
  "title" text NOT NULL,
  "document_type" text NOT NULL,
  "embedding_status" text NOT NULL
);
CREATE INDEX "documents_tenant_idx" ON "content"."documents" ("tenant_id", "workspace_id");
CREATE INDEX "documents_file_idx" ON "content"."documents" ("file_id");
CREATE INDEX "documents_folder_idx" ON "content"."documents" ("folder_id");
CREATE INDEX "documents_embedding_status_idx" ON "content"."documents" ("embedding_status");

CREATE TABLE "content"."content_generations" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "execution_step_id" uuid NOT NULL,
  "generation_type" text NOT NULL,
  "source_document_ids" uuid[],
  "output_document_id" uuid REFERENCES "content"."documents"("id"),
  "recipe_config" jsonb NOT NULL
);
CREATE INDEX "content_generations_tenant_idx" ON "content"."content_generations" ("tenant_id", "workspace_id");
CREATE INDEX "content_generations_step_idx" ON "content"."content_generations" ("execution_step_id");

------------------------------------------------------------
-- graph
------------------------------------------------------------

CREATE TABLE "graph"."graph_providers" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "provider_type" text NOT NULL,
  "display_name" text NOT NULL,
  "connection_id" uuid,
  "status" text NOT NULL
);
CREATE INDEX "graph_providers_tenant_idx" ON "graph"."graph_providers" ("tenant_id", "workspace_id");

CREATE TABLE "graph"."routing_rules" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "rule_name" text NOT NULL,
  "match_expression" jsonb NOT NULL,
  "target_graph_id" uuid NOT NULL REFERENCES "graph"."graph_providers"("id"),
  "priority" integer NOT NULL
);
CREATE INDEX "routing_rules_tenant_idx" ON "graph"."routing_rules" ("tenant_id", "workspace_id");
CREATE INDEX "routing_rules_tenant_priority_idx" ON "graph"."routing_rules" ("tenant_id", "priority");

------------------------------------------------------------
-- evaluation
------------------------------------------------------------

CREATE TABLE "evaluation"."evals" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "name" text NOT NULL,
  "eval_type" text NOT NULL,
  "dataset_config" jsonb NOT NULL
);
CREATE INDEX "evals_tenant_idx" ON "evaluation"."evals" ("tenant_id", "workspace_id");

CREATE TABLE "evaluation"."eval_runs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('pending','queued','running','completed','failed','cancelled','timed_out')),
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "cancelled_at" timestamptz,
  "eval_id" uuid NOT NULL REFERENCES "evaluation"."evals"("id") ON DELETE CASCADE,
  "agent_version_id" uuid NOT NULL,
  "score" numeric(5,2),
  "results_payload" jsonb NOT NULL
);
CREATE INDEX "eval_runs_eval_idx" ON "evaluation"."eval_runs" ("eval_id");
CREATE INDEX "eval_runs_agent_version_idx" ON "evaluation"."eval_runs" ("agent_version_id");
CREATE INDEX "eval_runs_status_idx" ON "evaluation"."eval_runs" ("status");

------------------------------------------------------------
-- billing
------------------------------------------------------------

CREATE TABLE "billing"."plans" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "name" text NOT NULL,
  "slug" citext NOT NULL,
  "tier" text NOT NULL,
  "stripe_product_id" text NOT NULL,
  "stripe_price_id_monthly" text,
  "stripe_price_id_annual" text,
  "monthly_cents" integer NOT NULL,
  "annual_cents" integer,
  "included_credit_cents" integer NOT NULL DEFAULT 0,
  "included_seats" integer NOT NULL DEFAULT 1,
  "features" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "is_public" boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX "plans_slug_idx" ON "billing"."plans" ("slug");

CREATE TABLE "billing"."subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id"),
  "plan_id" uuid NOT NULL REFERENCES "billing"."plans"("id"),
  "stripe_subscription_id" text NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "status" text NOT NULL CHECK ("status" IN ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused')),
  "billing_interval" text NOT NULL,
  "current_period_start" timestamptz NOT NULL,
  "current_period_end" timestamptz NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "canceled_at" timestamptz,
  "trial_end" timestamptz,
  "seat_count" integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX "subscriptions_stripe_sub_idx" ON "billing"."subscriptions" ("stripe_subscription_id");
CREATE INDEX "subscriptions_tenant_status_idx" ON "billing"."subscriptions" ("tenant_id", "status");

CREATE TABLE "billing"."payment_methods" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "deleted_at" timestamptz,
  "deleted_by_user_id" uuid,
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id"),
  "stripe_customer_id" text NOT NULL,
  "stripe_payment_method_id" text NOT NULL,
  "type" text NOT NULL,
  "brand" text,
  "last4" text,
  "exp_month" integer,
  "exp_year" integer,
  "is_default" boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "payment_methods_stripe_pm_idx" ON "billing"."payment_methods" ("stripe_payment_method_id");
CREATE INDEX "payment_methods_tenant_idx" ON "billing"."payment_methods" ("tenant_id");
-- Spec §6.13: at most one default PM per tenant. Partial unique index
-- enforces "default-or-none" without blocking multiple non-default PMs.
CREATE UNIQUE INDEX "payment_methods_tenant_default_idx" ON "billing"."payment_methods" ("tenant_id") WHERE "is_default" = true AND "deleted_at" IS NULL;

CREATE TABLE "billing"."invoices" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id"),
  "subscription_id" uuid REFERENCES "billing"."subscriptions"("id"),
  "stripe_invoice_id" text NOT NULL,
  "number" text,
  "status" text NOT NULL CHECK ("status" IN ('draft','open','paid','void','uncollectible')),
  "amount_due_cents" integer NOT NULL,
  "amount_paid_cents" integer NOT NULL DEFAULT 0,
  "amount_remaining_cents" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "due_at" timestamptz,
  "paid_at" timestamptz,
  "hosted_invoice_url" text,
  "invoice_pdf_url" text
);
CREATE UNIQUE INDEX "invoices_stripe_inv_idx" ON "billing"."invoices" ("stripe_invoice_id");
CREATE INDEX "invoices_tenant_idx" ON "billing"."invoices" ("tenant_id", "status");

CREATE TABLE "billing"."invoice_line_items" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "invoice_id" uuid NOT NULL REFERENCES "billing"."invoices"("id") ON DELETE CASCADE,
  "description" text NOT NULL,
  "quantity" numeric(18,4) NOT NULL,
  "unit_amount_cents" integer NOT NULL,
  "total_cents" integer NOT NULL,
  "metric" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX "invoice_line_items_invoice_idx" ON "billing"."invoice_line_items" ("invoice_id");

CREATE TABLE "billing"."usage_records" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id"),
  "subscription_id" uuid NOT NULL REFERENCES "billing"."subscriptions"("id"),
  "metric" text NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "unit_cost_micros" bigint NOT NULL,
  "total_cost_micros" bigint NOT NULL,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "source_query_id" text
);
CREATE UNIQUE INDEX "usage_records_sub_metric_period_idx" ON "billing"."usage_records" ("subscription_id", "metric", "period_start", "period_end");
CREATE INDEX "usage_records_tenant_idx" ON "billing"."usage_records" ("tenant_id");

CREATE TABLE "billing"."credit_balances" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid,
  "updated_by_user_id" uuid,
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id"),
  "balance_cents" bigint NOT NULL DEFAULT 0,
  "last_event_at" timestamptz
);
CREATE UNIQUE INDEX "credit_balances_tenant_idx" ON "billing"."credit_balances" ("tenant_id");

CREATE TABLE "billing"."credit_ledger" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "organization"."tenants"("id"),
  "delta_cents" bigint NOT NULL,
  "reason" text NOT NULL CHECK ("reason" IN ('grant_signup','grant_plan_renewal','grant_manual','consume_execution','consume_tool_call','consume_token_overage','refund','adjustment')),
  "reference_type" text,
  "reference_id" uuid,
  "created_by_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "credit_ledger_tenant_created_idx" ON "billing"."credit_ledger" ("tenant_id", "created_at" DESC);

CREATE TABLE "billing"."stripe_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "public_id" citext UNIQUE NOT NULL,
  "stripe_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "api_version" text,
  "payload" jsonb NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "processing_error" text
);
-- Webhook idempotency anchor: ON CONFLICT (stripe_event_id) DO NOTHING.
CREATE UNIQUE INDEX "stripe_events_stripe_event_idx" ON "billing"."stripe_events" ("stripe_event_id");
CREATE INDEX "stripe_events_type_idx" ON "billing"."stripe_events" ("event_type");
