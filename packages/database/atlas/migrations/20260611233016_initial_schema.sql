-- Install required extensions. These are idempotent; safe to run on any existing DB.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- uuid_generate_v7(): native on PG17+; stub on PG16 via pg_uuidv7 or v4 fallback.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_uuidv7;
  EXCEPTION WHEN OTHERS THEN
    CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
    RETURNS uuid LANGUAGE sql AS $fn$ SELECT uuid_generate_v4() $fn$;
  END;
END$$;

-- Add new schema named "agent"
CREATE SCHEMA "agent";
-- Add new schema named "auth"
CREATE SCHEMA "auth";
-- Add new schema named "billing"
CREATE SCHEMA "billing";
-- Add new schema named "chat"
CREATE SCHEMA "chat";
-- Add new schema named "content"
CREATE SCHEMA "content";
-- Add new schema named "graph"
CREATE SCHEMA "graph";
-- Add new schema named "iam"
CREATE SCHEMA "iam";
-- Add new schema named "ingestion"
CREATE SCHEMA "ingestion";
-- Add new schema named "mcp"
CREATE SCHEMA "mcp";
-- Add new schema named "notification"
CREATE SCHEMA "notification";
-- Add new schema named "org"
CREATE SCHEMA "org";
-- Add new schema named "plugin"
CREATE SCHEMA "plugin";
-- Add new schema named "privacy"
CREATE SCHEMA "privacy";
-- Add new schema named "security"
CREATE SCHEMA "security";
-- Add new schema named "workflow"
CREATE SCHEMA "workflow";
-- Add new schema named "workspace"
CREATE SCHEMA "workspace";
-- Create "agent_plans" table
CREATE TABLE "agent"."agent_plans" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "goals" jsonb NOT NULL DEFAULT '[]',
  "constraints" jsonb NOT NULL DEFAULT '[]',
  "tasks" jsonb NOT NULL DEFAULT '[]',
  "approval_required" boolean NOT NULL DEFAULT true,
  "message_id" uuid NULL,
  "approved_at" timestamptz NULL,
  "approved_by_user_id" uuid NULL,
  "task_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_plans_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agent_plans_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'awaiting_approval'::text, 'approved'::text, 'denied'::text, 'amended'::text, 'executing'::text, 'completed'::text]))
);
-- Create index "agent_plans_message_idx" to table: "agent_plans"
CREATE INDEX "agent_plans_message_idx" ON "agent"."agent_plans" ("message_id");
-- Create index "agent_plans_org_idx" to table: "agent_plans"
CREATE INDEX "agent_plans_org_idx" ON "agent"."agent_plans" ("org_id", "workspace_id");
-- Create index "agent_plans_org_status_idx" to table: "agent_plans"
CREATE INDEX "agent_plans_org_status_idx" ON "agent"."agent_plans" ("org_id", "workspace_id", "status");
-- Create "agents" table
CREATE TABLE "agent"."agents" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "slug" public.citext NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "agent_type" text NOT NULL,
  "active_version_id" uuid NULL,
  "status" text NOT NULL DEFAULT 'draft',
  PRIMARY KEY ("id"),
  CONSTRAINT "agents_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agents_slug_check" CHECK (slug OPERATOR(public.~) '^[a-z0-9]+(-[a-z0-9]+)*$'::public.citext),
  CONSTRAINT "agents_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text]))
);
-- Create index "agents_org_idx" to table: "agents"
CREATE INDEX "agents_org_idx" ON "agent"."agents" ("org_id", "workspace_id");
-- Create index "agents_workspace_slug_uniq" to table: "agents"
CREATE UNIQUE INDEX "agents_workspace_slug_uniq" ON "agent"."agents" ("workspace_id", "slug") WHERE (deleted_at IS NULL);
-- Create "approval_requests" table
CREATE TABLE "agent"."approval_requests" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "execution_step_id" uuid NULL,
  "tool_call_id" uuid NULL,
  "message_id" uuid NOT NULL,
  "capability_name" text NOT NULL,
  "input_preview" jsonb NOT NULL,
  "risk_level" text NOT NULL,
  "resolution" text NULL,
  "resolved_at" timestamptz NULL,
  "resolved_by_user_id" uuid NULL,
  "note" text NULL,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "approval_requests_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "approval_requests_resolution_check" CHECK ((resolution = ANY (ARRAY['approved'::text, 'denied'::text, 'expired'::text])) OR (resolution IS NULL)),
  CONSTRAINT "approval_requests_risk_level_check" CHECK (risk_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))
);
-- Create index "approval_requests_message_idx" to table: "approval_requests"
CREATE INDEX "approval_requests_message_idx" ON "agent"."approval_requests" ("message_id");
-- Create index "approval_requests_org_idx" to table: "approval_requests"
CREATE INDEX "approval_requests_org_idx" ON "agent"."approval_requests" ("org_id", "workspace_id");
-- Create index "approval_requests_org_resolution_idx" to table: "approval_requests"
CREATE INDEX "approval_requests_org_resolution_idx" ON "agent"."approval_requests" ("org_id", "workspace_id", "resolution");
-- Create "background_tasks" table
CREATE TABLE "agent"."background_tasks" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "label" text NULL,
  "inngest_run_id" text NOT NULL,
  "status" text NOT NULL,
  "input_payload" jsonb NOT NULL,
  "result_payload" jsonb NULL,
  "failure_reason" text NULL,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "background_tasks_inngest_run_id_unique" UNIQUE ("inngest_run_id"),
  CONSTRAINT "background_tasks_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "background_tasks_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))
);
-- Create index "background_tasks_org_idx" to table: "background_tasks"
CREATE INDEX "background_tasks_org_idx" ON "agent"."background_tasks" ("org_id", "workspace_id");
-- Create index "background_tasks_org_status_idx" to table: "background_tasks"
CREATE INDEX "background_tasks_org_status_idx" ON "agent"."background_tasks" ("org_id", "workspace_id", "status");
-- Create "skill_versions" table
CREATE TABLE "agent"."skill_versions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "parent_version_id" uuid NULL,
  "published_at" timestamptz NULL,
  "skill_id" uuid NOT NULL,
  "body" text NOT NULL,
  "references_payload" jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY ("id"),
  CONSTRAINT "skill_versions_public_id_unique" UNIQUE ("public_id")
);
-- Create index "skill_versions_org_idx" to table: "skill_versions"
CREATE INDEX "skill_versions_org_idx" ON "agent"."skill_versions" ("org_id", "workspace_id");
-- Create index "skill_versions_skill_idx" to table: "skill_versions"
CREATE INDEX "skill_versions_skill_idx" ON "agent"."skill_versions" ("skill_id");
-- Create index "skill_versions_skill_latest_idx" to table: "skill_versions"
CREATE UNIQUE INDEX "skill_versions_skill_latest_idx" ON "agent"."skill_versions" ("skill_id") WHERE (is_latest = true);
-- Create index "skill_versions_skill_version_idx" to table: "skill_versions"
CREATE UNIQUE INDEX "skill_versions_skill_version_idx" ON "agent"."skill_versions" ("skill_id", "version_number");
-- Create "skills" table
CREATE TABLE "agent"."skills" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "description" text NULL,
  "source" public.citext NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "skills_public_id_unique" UNIQUE ("public_id")
);
-- Create index "skills_org_idx" to table: "skills"
CREATE INDEX "skills_org_idx" ON "agent"."skills" ("org_id", "workspace_id");
-- Create index "skills_workspace_slug_idx" to table: "skills"
CREATE UNIQUE INDEX "skills_workspace_slug_idx" ON "agent"."skills" ("workspace_id", "slug");
-- Create "subagent_fanouts" table
CREATE TABLE "agent"."subagent_fanouts" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "parent_message_id" uuid NOT NULL,
  "inngest_event_id" text NULL,
  "status" text NOT NULL,
  "total_children" integer NOT NULL,
  "completed_children" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "subagent_fanouts_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "subagent_fanouts_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'partial'::text, 'timed_out'::text]))
);
-- Create index "subagent_fanouts_org_idx" to table: "subagent_fanouts"
CREATE INDEX "subagent_fanouts_org_idx" ON "agent"."subagent_fanouts" ("org_id", "workspace_id");
-- Create index "subagent_fanouts_parent_message_idx" to table: "subagent_fanouts"
CREATE INDEX "subagent_fanouts_parent_message_idx" ON "agent"."subagent_fanouts" ("parent_message_id");
-- Create "subagent_runs" table
CREATE TABLE "agent"."subagent_runs" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "fanout_id" uuid NOT NULL,
  "child_message_id" uuid NOT NULL,
  "capability_name" text NOT NULL,
  "input_payload" jsonb NOT NULL,
  "output_payload" jsonb NULL,
  "status" text NOT NULL,
  "error_reason" text NULL,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "subagent_runs_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "subagent_runs_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text]))
);
-- Create index "subagent_runs_fanout_idx" to table: "subagent_runs"
CREATE INDEX "subagent_runs_fanout_idx" ON "agent"."subagent_runs" ("fanout_id");
-- Create index "subagent_runs_org_idx" to table: "subagent_runs"
CREATE INDEX "subagent_runs_org_idx" ON "agent"."subagent_runs" ("org_id", "workspace_id");
-- Create index "subagent_runs_status_idx" to table: "subagent_runs"
CREATE INDEX "subagent_runs_status_idx" ON "agent"."subagent_runs" ("status");
-- Create enum type "density"
CREATE TYPE "auth"."density" AS ENUM ('compact', 'comfortable', 'spacious');
-- Create enum type "font_size"
CREATE TYPE "auth"."font_size" AS ENUM ('small', 'medium', 'large');
-- Create enum type "model_tier"
CREATE TYPE "auth"."model_tier" AS ENUM ('fast', 'balanced', 'precise');
-- Create enum type "pending_prompt_behavior"
CREATE TYPE "auth"."pending_prompt_behavior" AS ENUM ('queue', 'interrupt');
-- Create "accounts" table
CREATE TABLE "auth"."accounts" (
  "id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "access_token" text NULL,
  "refresh_token" text NULL,
  "id_token" text NULL,
  "access_token_enc" bytea NULL,
  "refresh_token_enc" bytea NULL,
  "id_token_enc" bytea NULL,
  "token_kms_key_id" text NULL,
  "access_token_expires_at" timestamptz NULL,
  "refresh_token_expires_at" timestamptz NULL,
  "scope" text NULL,
  "password" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "accounts_provider_account_idx" to table: "accounts"
CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "auth"."accounts" ("provider_id", "account_id");
-- Create index "accounts_user_idx" to table: "accounts"
CREATE INDEX "accounts_user_idx" ON "auth"."accounts" ("user_id");
-- Create "api_keys" table
CREATE TABLE "auth"."api_keys" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "key_prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "name" text NOT NULL,
  "scope" jsonb NOT NULL,
  "expires_at" timestamptz NULL,
  "last_used_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_public_id_unique" UNIQUE ("public_id")
);
-- Create index "api_keys_key_prefix_idx" to table: "api_keys"
CREATE UNIQUE INDEX "api_keys_key_prefix_idx" ON "auth"."api_keys" ("key_prefix");
-- Create index "api_keys_org_idx" to table: "api_keys"
CREATE INDEX "api_keys_org_idx" ON "auth"."api_keys" ("org_id", "workspace_id");
-- Create "credentials" table
CREATE TABLE "auth"."credentials" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "provider" text NOT NULL,
  "credential_type" text NOT NULL,
  "encrypted_payload" bytea NOT NULL,
  "kms_key_id" text NULL,
  "expires_at" timestamptz NULL,
  "last_used_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "credentials_public_id_unique" UNIQUE ("public_id")
);
-- Create index "credentials_org_idx" to table: "credentials"
CREATE INDEX "credentials_org_idx" ON "auth"."credentials" ("org_id", "workspace_id");
-- Create index "credentials_provider_idx" to table: "credentials"
CREATE INDEX "credentials_provider_idx" ON "auth"."credentials" ("org_id", "provider");
-- Create "rate_limit" table
CREATE TABLE "auth"."rate_limit" (
  "id" text NOT NULL,
  "key" text NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  "lastRequest" bigint NOT NULL DEFAULT 0,
  PRIMARY KEY ("id")
);
-- Create index "rate_limit_key_idx" to table: "rate_limit"
CREATE UNIQUE INDEX "rate_limit_key_idx" ON "auth"."rate_limit" ("key");
-- Create "sessions" table
CREATE TABLE "auth"."sessions" (
  "id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "ip_address" text NULL,
  "user_agent" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "sessions_expires_idx" to table: "sessions"
CREATE INDEX "sessions_expires_idx" ON "auth"."sessions" ("expires_at");
-- Create index "sessions_token_idx" to table: "sessions"
CREATE UNIQUE INDEX "sessions_token_idx" ON "auth"."sessions" ("token");
-- Create index "sessions_user_idx" to table: "sessions"
CREATE INDEX "sessions_user_idx" ON "auth"."sessions" ("user_id");
-- Create "verifications" table
CREATE TABLE "auth"."verifications" (
  "id" text NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "verifications_identifier_idx" to table: "verifications"
CREATE INDEX "verifications_identifier_idx" ON "auth"."verifications" ("identifier");
-- Create "conversations" table
CREATE TABLE "chat"."conversations" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "title" text NULL,
  "status" text NOT NULL,
  "active_leaf_message_id" uuid NULL,
  "archived_at" timestamptz NULL,
  "archived_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "conversations_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "conversations_status_check" CHECK (status = ANY (ARRAY['active'::text, 'archived'::text, 'deleted'::text]))
);
-- Create index "conversations_list_idx" to table: "conversations"
CREATE INDEX "conversations_list_idx" ON "chat"."conversations" ("workspace_id", "user_id", "deleted_at", "archived_at", "updated_at");
-- Create index "conversations_org_idx" to table: "conversations"
CREATE INDEX "conversations_org_idx" ON "chat"."conversations" ("org_id", "workspace_id");
-- Create index "conversations_user_idx" to table: "conversations"
CREATE INDEX "conversations_user_idx" ON "chat"."conversations" ("user_id");
-- Create "messages" table
CREATE TABLE "chat"."messages" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL,
  "parent_message_id" uuid NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "content_blocks" jsonb NOT NULL,
  "branch_reason" text NULL,
  "is_active_in_branch" boolean NOT NULL DEFAULT true,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "messages_public_id_unique" UNIQUE ("public_id")
);
-- Create index "messages_conversation_parent_idx" to table: "messages"
CREATE INDEX "messages_conversation_parent_idx" ON "chat"."messages" ("conversation_id", "parent_message_id");
-- Create index "messages_org_idx" to table: "messages"
CREATE INDEX "messages_org_idx" ON "chat"."messages" ("org_id", "workspace_id");
-- Create "documents" table
CREATE TABLE "content"."documents" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "title" text NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "metadata" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "documents_public_id_unique" UNIQUE ("public_id")
);
-- Create index "documents_org_idx" to table: "documents"
CREATE INDEX "documents_org_idx" ON "content"."documents" ("org_id", "workspace_id");
-- Create "form_submissions" table
CREATE TABLE "content"."form_submissions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "form_id" uuid NOT NULL,
  "responses" jsonb NOT NULL DEFAULT '{}',
  "status" public.citext NOT NULL DEFAULT 'submitted'::public.citext,
  PRIMARY KEY ("id"),
  CONSTRAINT "form_submissions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "form_submissions_status_check" CHECK (status OPERATOR(public.=) ANY (ARRAY['submitted'::public.citext, 'reviewed'::public.citext, 'archived'::public.citext]))
);
-- Create index "form_submissions_form_idx" to table: "form_submissions"
CREATE INDEX "form_submissions_form_idx" ON "content"."form_submissions" ("form_id");
-- Create index "form_submissions_org_idx" to table: "form_submissions"
CREATE INDEX "form_submissions_org_idx" ON "content"."form_submissions" ("org_id", "workspace_id");
-- Create "forms" table
CREATE TABLE "content"."forms" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "title" text NOT NULL,
  "fields" jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY ("id"),
  CONSTRAINT "forms_public_id_unique" UNIQUE ("public_id")
);
-- Create index "forms_org_idx" to table: "forms"
CREATE INDEX "forms_org_idx" ON "content"."forms" ("org_id", "workspace_id");
-- Create "generated_assets" table
CREATE TABLE "content"."generated_assets" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "user_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "access_policy" text NOT NULL DEFAULT 'user',
  "status" text NOT NULL DEFAULT 'ready',
  "storage_provider" text NOT NULL,
  "storage_key" text NOT NULL,
  "storage_url" text NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NULL,
  "prompt" text NOT NULL,
  "model" text NOT NULL,
  "conversation_id" uuid NULL,
  "message_id" uuid NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "generated_assets_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "generated_assets_access_policy_check" CHECK (access_policy = ANY (ARRAY['user'::text, 'org'::text, 'public'::text])),
  CONSTRAINT "generated_assets_kind_check" CHECK (kind = ANY (ARRAY['image'::text, 'video'::text, 'document'::text, 'spreadsheet'::text, 'presentation'::text, 'pdf'::text, 'archive'::text])),
  CONSTRAINT "generated_assets_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text]))
);
-- Create index "generated_assets_conversation_idx" to table: "generated_assets"
CREATE INDEX "generated_assets_conversation_idx" ON "content"."generated_assets" ("conversation_id");
-- Create index "generated_assets_org_idx" to table: "generated_assets"
CREATE INDEX "generated_assets_org_idx" ON "content"."generated_assets" ("org_id", "workspace_id");
-- Create index "generated_assets_user_idx" to table: "generated_assets"
CREATE INDEX "generated_assets_user_idx" ON "content"."generated_assets" ("user_id");
-- Create "outbox" table
CREATE TABLE "graph"."outbox" (
  "id" bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  "aggregate_type" text NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "op" text NOT NULL,
  "payload" jsonb NOT NULL,
  "version" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text NULL,
  PRIMARY KEY ("id")
);
-- Create index "graph_outbox_aggregate_idx" to table: "outbox"
CREATE INDEX "graph_outbox_aggregate_idx" ON "graph"."outbox" ("aggregate_type", "aggregate_id");
-- Create index "graph_outbox_org_idx" to table: "outbox"
CREATE INDEX "graph_outbox_org_idx" ON "graph"."outbox" ("org_id", "workspace_id");
-- Create index "graph_outbox_pending_idx" to table: "outbox"
CREATE INDEX "graph_outbox_pending_idx" ON "graph"."outbox" ("id") WHERE (processed_at IS NULL);
-- Create "projection_checkpoints" table
CREATE TABLE "graph"."projection_checkpoints" (
  "projector_name" text NOT NULL,
  "last_processed_outbox_id" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("projector_name")
);
-- Create "access_requests" table
CREATE TABLE "iam"."access_requests" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "requester_id" uuid NOT NULL,
  "capability_id" text NOT NULL,
  "scope_kind" text NOT NULL,
  "scope_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "approver_id" uuid NULL,
  "approved_at" timestamptz NULL,
  "ttl_seconds" integer NULL,
  "justification" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "access_requests_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "access_requests_scope_kind_check" CHECK (scope_kind = ANY (ARRAY['org'::text, 'workspace'::text])),
  CONSTRAINT "access_requests_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text]))
);
-- Create index "access_requests_org_status_idx" to table: "access_requests"
CREATE INDEX "access_requests_org_status_idx" ON "iam"."access_requests" ("org_id", "status");
-- Create index "access_requests_requester_idx" to table: "access_requests"
CREATE INDEX "access_requests_requester_idx" ON "iam"."access_requests" ("requester_id");
-- Create "principal_role_assignments" table
CREATE TABLE "iam"."principal_role_assignments" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "principal_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NULL,
  "assigned_by" uuid NULL,
  "assigned_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "principal_role_assignments_public_id_unique" UNIQUE ("public_id")
);
-- Create index "pra_principal_org_idx" to table: "principal_role_assignments"
CREATE INDEX "pra_principal_org_idx" ON "iam"."principal_role_assignments" ("principal_id", "org_id");
-- Create index "pra_principal_role_org_null_workspace_idx" to table: "principal_role_assignments"
CREATE UNIQUE INDEX "pra_principal_role_org_null_workspace_idx" ON "iam"."principal_role_assignments" ("principal_id", "role_id", "org_id") WHERE (workspace_id IS NULL);
-- Create index "pra_principal_role_org_workspace_idx" to table: "principal_role_assignments"
CREATE UNIQUE INDEX "pra_principal_role_org_workspace_idx" ON "iam"."principal_role_assignments" ("principal_id", "role_id", "org_id", "workspace_id") WHERE (workspace_id IS NOT NULL);
-- Create index "pra_role_org_idx" to table: "principal_role_assignments"
CREATE INDEX "pra_role_org_idx" ON "iam"."principal_role_assignments" ("role_id", "org_id");
-- Create index "pra_workspace_idx" to table: "principal_role_assignments"
CREATE INDEX "pra_workspace_idx" ON "iam"."principal_role_assignments" ("workspace_id");
-- Create "principals" table
CREATE TABLE "iam"."principals" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NULL,
  "kind" text NOT NULL,
  "display_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "mfa_status" text NOT NULL DEFAULT 'none',
  "idp_subject" text NULL,
  "parent_user_id" uuid NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "principals_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "principals_kind_check" CHECK (kind = ANY (ARRAY['human'::text, 'agent'::text, 'service'::text])),
  CONSTRAINT "principals_status_check" CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text]))
);
-- Create index "principals_idp_subject_idx" to table: "principals"
CREATE INDEX "principals_idp_subject_idx" ON "iam"."principals" ("idp_subject");
-- Create index "principals_org_kind_idx" to table: "principals"
CREATE INDEX "principals_org_kind_idx" ON "iam"."principals" ("org_id", "kind");
-- Create index "principals_workspace_idx" to table: "principals"
CREATE INDEX "principals_workspace_idx" ON "iam"."principals" ("workspace_id");
-- Create "role_grants" table
CREATE TABLE "iam"."role_grants" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "role_id" uuid NOT NULL,
  "capability_id" text NOT NULL,
  "effect" text NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "role_grants_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "role_grants_effect_check" CHECK (effect = ANY (ARRAY['allow'::text, 'deny'::text, 'require_approval'::text]))
);
-- Create index "role_grants_org_idx" to table: "role_grants"
CREATE INDEX "role_grants_org_idx" ON "iam"."role_grants" ("org_id");
-- Create index "role_grants_role_capability_idx" to table: "role_grants"
CREATE INDEX "role_grants_role_capability_idx" ON "iam"."role_grants" ("role_id", "capability_id");
-- Create "roles" table
CREATE TABLE "iam"."roles" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "scope_kind" text NOT NULL,
  "name" text NOT NULL,
  "description" text NULL,
  "is_system_default" boolean NOT NULL DEFAULT false,
  "version" text NOT NULL DEFAULT '1',
  "parent_role_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "roles_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "roles_scope_kind_check" CHECK (scope_kind = ANY (ARRAY['org'::text, 'workspace'::text]))
);
-- Create index "roles_org_name_idx" to table: "roles"
CREATE INDEX "roles_org_name_idx" ON "iam"."roles" ("org_id", "name");
-- Create "auth_credentials" table
CREATE TABLE "ingestion"."auth_credentials" (
  "connection_id" uuid NOT NULL,
  "auth_scheme" text NOT NULL,
  "encrypted_payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("connection_id")
);
-- Create "connector_schemas" table
CREATE TABLE "ingestion"."connector_schemas" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "plugin_id" text NOT NULL,
  "schema_url" text NULL,
  "schema" jsonb NOT NULL DEFAULT '{}',
  "schema_version" text NOT NULL,
  "plugin_version" text NOT NULL,
  "cached_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "connector_schemas_plugin_version_uniq" UNIQUE ("plugin_id", "plugin_version")
);
-- Create index "connector_schemas_cached_at_idx" to table: "connector_schemas"
CREATE INDEX "connector_schemas_cached_at_idx" ON "ingestion"."connector_schemas" ("cached_at");
-- Create index "connector_schemas_plugin_id_idx" to table: "connector_schemas"
CREATE INDEX "connector_schemas_plugin_id_idx" ON "ingestion"."connector_schemas" ("plugin_id");
-- Create "deletion_jobs" table
CREATE TABLE "ingestion"."deletion_jobs" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "connection_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "delete_mode" text NOT NULL,
  "requested_by" uuid NOT NULL,
  "total_entities" integer NULL,
  "deleted_entities" integer NOT NULL DEFAULT 0,
  "alias_promotions" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'running',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz NULL,
  "error" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "deletion_jobs_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "deletion_jobs_delete_mode_check" CHECK (delete_mode = ANY (ARRAY['soft'::text, 'hard'::text])),
  CONSTRAINT "deletion_jobs_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))
);
-- Create index "deletion_jobs_connection_idx" to table: "deletion_jobs"
CREATE INDEX "deletion_jobs_connection_idx" ON "ingestion"."deletion_jobs" ("connection_id");
-- Create index "deletion_jobs_status_idx" to table: "deletion_jobs"
CREATE INDEX "deletion_jobs_status_idx" ON "ingestion"."deletion_jobs" ("status");
-- Create index "deletion_jobs_workspace_idx" to table: "deletion_jobs"
CREATE INDEX "deletion_jobs_workspace_idx" ON "ingestion"."deletion_jobs" ("workspace_id");
-- Create "entity_type_mappings" table
CREATE TABLE "ingestion"."entity_type_mappings" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "connection_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "source_record_type" text NOT NULL,
  "oxagen_entity_type" text NOT NULL,
  "property_mappings" jsonb NOT NULL DEFAULT '{}',
  "is_active" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "entity_type_mappings_connection_type_uniq" UNIQUE ("connection_id", "source_record_type"),
  CONSTRAINT "entity_type_mappings_public_id_unique" UNIQUE ("public_id")
);
-- Create index "entity_type_mappings_connection_idx" to table: "entity_type_mappings"
CREATE INDEX "entity_type_mappings_connection_idx" ON "ingestion"."entity_type_mappings" ("connection_id");
-- Create index "entity_type_mappings_workspace_type_idx" to table: "entity_type_mappings"
CREATE INDEX "entity_type_mappings_workspace_type_idx" ON "ingestion"."entity_type_mappings" ("workspace_id", "oxagen_entity_type");
-- Create "entity_types" table
CREATE TABLE "ingestion"."entity_types" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "workspace_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "description" text NULL,
  "common_property_keys" text[] NOT NULL DEFAULT '{}',
  "expected_edges" jsonb NOT NULL DEFAULT '[]',
  "row_count" integer NOT NULL DEFAULT 0,
  "last_seen_at" timestamptz NULL,
  "is_custom" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("id"),
  CONSTRAINT "entity_types_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "entity_types_workspace_name_uniq" UNIQUE ("workspace_id", "name")
);
-- Create index "entity_types_last_seen_idx" to table: "entity_types"
CREATE INDEX "entity_types_last_seen_idx" ON "ingestion"."entity_types" ("last_seen_at");
-- Create index "entity_types_workspace_org_idx" to table: "entity_types"
CREATE INDEX "entity_types_workspace_org_idx" ON "ingestion"."entity_types" ("workspace_id", "org_id");
-- Create "oauth_accounts" table
CREATE TABLE "ingestion"."oauth_accounts" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "org_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_user_id" text NOT NULL,
  "provider_user_email" text NULL,
  "provider_user_name" text NULL,
  "access_token_enc" jsonb NOT NULL,
  "refresh_token_enc" jsonb NULL,
  "expires_at" timestamptz NULL,
  "token_type" text NOT NULL DEFAULT 'Bearer',
  "scopes" text[] NOT NULL DEFAULT '{}',
  "last_refreshed_at" timestamptz NULL,
  "refresh_failure_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CONSTRAINT "oauth_accounts_org_provider_user_uq" UNIQUE ("org_id", "provider", "provider_user_id"),
  CONSTRAINT "oauth_accounts_public_id_unique" UNIQUE ("public_id")
);
-- Create index "oauth_accounts_expires_at_idx" to table: "oauth_accounts"
CREATE INDEX "oauth_accounts_expires_at_idx" ON "ingestion"."oauth_accounts" ("expires_at");
-- Create index "oauth_accounts_org_provider_idx" to table: "oauth_accounts"
CREATE INDEX "oauth_accounts_org_provider_idx" ON "ingestion"."oauth_accounts" ("org_id", "provider");
-- Create "oauth_tokens" table
CREATE TABLE "ingestion"."oauth_tokens" (
  "connection_id" uuid NOT NULL,
  "access_token_enc" jsonb NOT NULL,
  "refresh_token_enc" jsonb NULL,
  "expires_at" timestamptz NULL,
  "token_type" text NOT NULL DEFAULT 'Bearer',
  "scopes" text[] NOT NULL DEFAULT '{}',
  "provider_user_id" text NULL,
  "provider_account_id" text NULL,
  "last_refreshed_at" timestamptz NULL,
  "refresh_failure_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("connection_id")
);
-- Create index "oauth_tokens_expires_at_idx" to table: "oauth_tokens"
CREATE INDEX "oauth_tokens_expires_at_idx" ON "ingestion"."oauth_tokens" ("expires_at");
-- Create "setup_suggestions" table
CREATE TABLE "ingestion"."setup_suggestions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "connection_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source_record_type" text NOT NULL,
  "suggested_entity_type" text NOT NULL,
  "suggested_property_mappings" jsonb NOT NULL DEFAULT '{}',
  "reasoning" text NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "resolved_at" timestamptz NULL,
  "resolved_by" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "setup_suggestions_public_id_unique" UNIQUE ("public_id")
);
-- Create index "setup_suggestions_connection_idx" to table: "setup_suggestions"
CREATE INDEX "setup_suggestions_connection_idx" ON "ingestion"."setup_suggestions" ("connection_id");
-- Create index "setup_suggestions_org_idx" to table: "setup_suggestions"
CREATE INDEX "setup_suggestions_org_idx" ON "ingestion"."setup_suggestions" ("org_id", "workspace_id");
-- Create index "setup_suggestions_status_idx" to table: "setup_suggestions"
CREATE INDEX "setup_suggestions_status_idx" ON "ingestion"."setup_suggestions" ("status");
-- Create "source_connections" table
CREATE TABLE "ingestion"."source_connections" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "workspace_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "connector_id" text NOT NULL,
  "display_name" text NOT NULL,
  "auth_scheme" text NOT NULL,
  "delivery_method" text NOT NULL,
  "delivery_config" jsonb NULL,
  "status" text NOT NULL DEFAULT 'pending_setup',
  "entity_count" integer NOT NULL DEFAULT 0,
  "cursor" jsonb NULL,
  "last_sync_at" timestamptz NULL,
  "error_message" text NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "oauth_account_id" uuid NULL,
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "source_connections_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "source_connections_status_check" CHECK (status = ANY (ARRAY['pending_setup'::text, 'connected'::text, 'paused'::text, 'error'::text]))
);
-- Create index "source_connections_connector_idx" to table: "source_connections"
CREATE INDEX "source_connections_connector_idx" ON "ingestion"."source_connections" ("connector_id");
-- Create index "source_connections_oauth_account_idx" to table: "source_connections"
CREATE INDEX "source_connections_oauth_account_idx" ON "ingestion"."source_connections" ("oauth_account_id");
-- Create index "source_connections_status_idx" to table: "source_connections"
CREATE INDEX "source_connections_status_idx" ON "ingestion"."source_connections" ("status");
-- Create index "source_connections_workspace_org_idx" to table: "source_connections"
CREATE INDEX "source_connections_workspace_org_idx" ON "ingestion"."source_connections" ("workspace_id", "org_id");
-- Create "webhook_subscriptions" table
CREATE TABLE "ingestion"."webhook_subscriptions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "connection_id" uuid NOT NULL,
  "webhook_path" text NOT NULL,
  "secret_enc" jsonb NULL,
  "hmac_algorithm" text NULL,
  "hmac_header" text NULL,
  "provider_subscription_id" text NULL,
  "record_types" text[] NOT NULL DEFAULT '{}',
  "status" text NOT NULL DEFAULT 'active',
  "last_received_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "webhook_subscriptions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "webhook_subscriptions_webhook_path_unique" UNIQUE ("webhook_path")
);
-- Create index "webhook_subscriptions_connection_idx" to table: "webhook_subscriptions"
CREATE INDEX "webhook_subscriptions_connection_idx" ON "ingestion"."webhook_subscriptions" ("connection_id");
-- Create index "webhook_subscriptions_status_idx" to table: "webhook_subscriptions"
CREATE INDEX "webhook_subscriptions_status_idx" ON "ingestion"."webhook_subscriptions" ("status");
-- Create "catalog_servers" table
CREATE TABLE "mcp"."catalog_servers" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "registry_id" uuid NOT NULL,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "is_latest" boolean NOT NULL DEFAULT false,
  "title" text NULL,
  "description" text NOT NULL,
  "repository" jsonb NULL,
  "website_url" text NULL,
  "icons" jsonb NOT NULL DEFAULT '[]',
  "packages" jsonb NOT NULL DEFAULT '[]',
  "remotes" jsonb NOT NULL DEFAULT '[]',
  "transport_types" text[] NOT NULL DEFAULT '{}',
  "auth_kind" text NOT NULL,
  "categories" text[] NOT NULL DEFAULT '{}',
  "readme_html" text NULL,
  "readme_fetched_at" timestamptz NULL,
  "status" text NOT NULL,
  "published_at" timestamptz NULL,
  "upstream_updated_at" timestamptz NULL,
  "status_changed_at" timestamptz NULL,
  "meta" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "catalog_servers_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "catalog_servers_auth_kind_check" CHECK (auth_kind = ANY (ARRAY['oauth'::text, 'secret'::text, 'none'::text])),
  CONSTRAINT "catalog_servers_status_check" CHECK (status = ANY (ARRAY['active'::text, 'deprecated'::text, 'deleted'::text]))
);
-- Create index "catalog_servers_categories_gin" to table: "catalog_servers"
CREATE INDEX "catalog_servers_categories_gin" ON "mcp"."catalog_servers" USING GIN ("categories");
-- Create index "catalog_servers_name_version_uniq" to table: "catalog_servers"
CREATE UNIQUE INDEX "catalog_servers_name_version_uniq" ON "mcp"."catalog_servers" ("registry_id", "name", "version");
-- Create index "catalog_servers_registry_name_idx" to table: "catalog_servers"
CREATE INDEX "catalog_servers_registry_name_idx" ON "mcp"."catalog_servers" ("registry_id", "name");
-- Create index "catalog_servers_transport_gin" to table: "catalog_servers"
CREATE INDEX "catalog_servers_transport_gin" ON "mcp"."catalog_servers" USING GIN ("transport_types");
-- Create "credentials" table
CREATE TABLE "mcp"."credentials" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "org_listing_id" uuid NOT NULL,
  "auth_kind" text NOT NULL,
  "access_token_enc" bytea NULL,
  "refresh_token_enc" bytea NULL,
  "secret_enc" bytea NULL,
  "oauth_client_secret_enc" bytea NULL,
  "token_kms_key_id" text NULL,
  "oauth_client_id" text NULL,
  "scopes" text[] NOT NULL DEFAULT '{}',
  "expires_at" timestamptz NULL,
  "status" text NOT NULL DEFAULT 'active',
  "last_refreshed_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "credentials_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "credentials_auth_kind_check" CHECK (auth_kind = ANY (ARRAY['oauth'::text, 'secret'::text])),
  CONSTRAINT "credentials_status_check" CHECK (status = ANY (ARRAY['active'::text, 'needs_reauth'::text, 'revoked'::text]))
);
-- Create index "credentials_org_idx" to table: "credentials"
CREATE INDEX "credentials_org_idx" ON "mcp"."credentials" ("org_id");
-- Create index "credentials_workspace_listing_uniq" to table: "credentials"
CREATE UNIQUE INDEX "credentials_workspace_listing_uniq" ON "mcp"."credentials" ("workspace_id", "org_listing_id");
-- Create "mcp_servers" table
CREATE TABLE "mcp"."mcp_servers" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "org_listing_id" uuid NULL,
  "name" text NOT NULL,
  "transport_type" text NOT NULL,
  "endpoint_url" text NOT NULL,
  "auth_strategy" text NOT NULL,
  "auth_config" jsonb NOT NULL DEFAULT '{}',
  "health_status" text NOT NULL,
  "last_healthcheck_at" timestamptz NULL,
  "discovered_tools" jsonb NOT NULL DEFAULT '[]',
  "enabled" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "mcp_servers_public_id_unique" UNIQUE ("public_id")
);
-- Create index "mcp_servers_enabled_idx" to table: "mcp_servers"
CREATE INDEX "mcp_servers_enabled_idx" ON "mcp"."mcp_servers" ("workspace_id", "enabled");
-- Create index "mcp_servers_org_idx" to table: "mcp_servers"
CREATE INDEX "mcp_servers_org_idx" ON "mcp"."mcp_servers" ("org_id", "workspace_id");
-- Create index "mcp_servers_ws_listing_uniq" to table: "mcp_servers"
CREATE UNIQUE INDEX "mcp_servers_ws_listing_uniq" ON "mcp"."mcp_servers" ("workspace_id", "org_listing_id") WHERE (org_listing_id IS NOT NULL);
-- Create "registries" table
CREATE TABLE "mcp"."registries" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NULL,
  "name" text NOT NULL,
  "base_url" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "is_default_seed" boolean NOT NULL DEFAULT false,
  "last_synced_at" timestamptz NULL,
  "last_synced_cursor" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "registries_public_id_unique" UNIQUE ("public_id")
);
-- Create index "registries_org_idx" to table: "registries"
CREATE INDEX "registries_org_idx" ON "mcp"."registries" ("org_id");
-- Create "notifications" table
CREATE TABLE "notification"."notifications" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NULL,
  "user_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text NULL,
  "deep_link" text NULL,
  "unread" boolean NOT NULL DEFAULT true,
  "archived" boolean NOT NULL DEFAULT false,
  "emailed_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "notifications_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "notifications_kind_check" CHECK (kind = ANY (ARRAY['system'::text, 'approval'::text, 'run'::text, 'member'::text, 'security'::text]))
);
-- Create index "notifications_org_idx" to table: "notifications"
CREATE INDEX "notifications_org_idx" ON "notification"."notifications" ("org_id");
-- Create index "notifications_user_unread_idx" to table: "notifications"
CREATE INDEX "notifications_user_unread_idx" ON "notification"."notifications" ("user_id", "unread") WHERE (archived = false);
-- Create "invitations" table
CREATE TABLE "org"."invitations" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "email" public.citext NOT NULL,
  "role" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "invited_by_user_id" uuid NOT NULL,
  "accepted_user_id" uuid NULL,
  "expires_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "invitations_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "invitations_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'revoked'::text, 'expired'::text]))
);
-- Create index "invitations_org_email_pending_idx" to table: "invitations"
CREATE UNIQUE INDEX "invitations_org_email_pending_idx" ON "org"."invitations" ("org_id", "email") WHERE (status = 'pending'::text);
-- Create index "invitations_org_status_idx" to table: "invitations"
CREATE INDEX "invitations_org_status_idx" ON "org"."invitations" ("org_id", "status");
-- Create "org_users" table
CREATE TABLE "org"."org_users" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "permissions" jsonb NOT NULL DEFAULT '{}',
  "joined_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "org_users_public_id_unique" UNIQUE ("public_id")
);
-- Create index "org_users_org_user_idx" to table: "org_users"
CREATE UNIQUE INDEX "org_users_org_user_idx" ON "org"."org_users" ("org_id", "user_id");
-- Create index "org_users_user_idx" to table: "org_users"
CREATE INDEX "org_users_user_idx" ON "org"."org_users" ("user_id");
-- Create "org_denylist" table
CREATE TABLE "plugin"."org_denylist" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "plugin_type" text NOT NULL,
  "server_name" text NOT NULL,
  "reason" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "org_denylist_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "org_denylist_type_check" CHECK (plugin_type = ANY (ARRAY['mcp_server'::text, 'integration'::text, 'content_tool'::text]))
);
-- Create index "org_denylist_org_type_name_uniq" to table: "org_denylist"
CREATE UNIQUE INDEX "org_denylist_org_type_name_uniq" ON "plugin"."org_denylist" ("org_id", "plugin_type", "server_name");
-- Create "org_listings" table
CREATE TABLE "plugin"."org_listings" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "plugin_type" text NOT NULL,
  "catalog_server_id" uuid NULL,
  "source" text NOT NULL,
  "name" text NOT NULL,
  "title" text NULL,
  "description" text NULL,
  "icon_url" text NULL,
  "endpoint_url" text NULL,
  "transport" text NULL,
  "auth_kind" text NOT NULL,
  "auth_config" jsonb NOT NULL DEFAULT '{}',
  "enabled" boolean NOT NULL DEFAULT false,
  "config" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "org_listings_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "org_listings_auth_kind_check" CHECK (auth_kind = ANY (ARRAY['oauth'::text, 'secret'::text, 'none'::text])),
  CONSTRAINT "org_listings_source_check" CHECK (source = ANY (ARRAY['registry'::text, 'custom'::text])),
  CONSTRAINT "org_listings_type_check" CHECK (plugin_type = ANY (ARRAY['mcp_server'::text, 'integration'::text, 'content_tool'::text]))
);
-- Create index "org_listings_org_type_idx" to table: "org_listings"
CREATE INDEX "org_listings_org_type_idx" ON "plugin"."org_listings" ("org_id", "plugin_type");
-- Create index "org_listings_org_type_name_uniq" to table: "org_listings"
CREATE UNIQUE INDEX "org_listings_org_type_name_uniq" ON "plugin"."org_listings" ("org_id", "plugin_type", "name");
-- Create enum type "privacy_erasure_status"
CREATE TYPE "privacy"."privacy_erasure_status" AS ENUM ('queued', 'processing', 'completed', 'failed');
-- Create enum type "privacy_export_status"
CREATE TYPE "privacy"."privacy_export_status" AS ENUM ('queued', 'processing', 'ready', 'failed');
-- Create enum type "privacy_request_scope"
CREATE TYPE "privacy"."privacy_request_scope" AS ENUM ('user', 'org');
-- Create "privacy_erasure_requests" table
CREATE TABLE "privacy"."privacy_erasure_requests" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "scope" "privacy"."privacy_request_scope" NOT NULL,
  "status" "privacy"."privacy_erasure_status" NOT NULL DEFAULT 'queued',
  "scheduled_at" timestamptz NOT NULL,
  "completed_at" timestamptz NULL,
  "error_message" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "privacy_erasure_requests_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "privacy_erasure_status_chk" CHECK (status = ANY (ARRAY['queued'::privacy.privacy_erasure_status, 'processing'::privacy.privacy_erasure_status, 'completed'::privacy.privacy_erasure_status, 'failed'::privacy.privacy_erasure_status]))
);
-- Create index "privacy_erasure_requests_org_idx" to table: "privacy_erasure_requests"
CREATE INDEX "privacy_erasure_requests_org_idx" ON "privacy"."privacy_erasure_requests" ("org_id");
-- Create index "privacy_erasure_requests_user_idx" to table: "privacy_erasure_requests"
CREATE INDEX "privacy_erasure_requests_user_idx" ON "privacy"."privacy_erasure_requests" ("user_id");
-- Create "privacy_export_requests" table
CREATE TABLE "privacy"."privacy_export_requests" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "user_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "scope" "privacy"."privacy_request_scope" NOT NULL,
  "status" "privacy"."privacy_export_status" NOT NULL DEFAULT 'queued',
  "export_url" text NULL,
  "completed_at" timestamptz NULL,
  "error_message" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "privacy_export_requests_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "privacy_export_status_chk" CHECK (status = ANY (ARRAY['queued'::privacy.privacy_export_status, 'processing'::privacy.privacy_export_status, 'ready'::privacy.privacy_export_status, 'failed'::privacy.privacy_export_status]))
);
-- Create index "privacy_export_requests_org_idx" to table: "privacy_export_requests"
CREATE INDEX "privacy_export_requests_org_idx" ON "privacy"."privacy_export_requests" ("org_id");
-- Create index "privacy_export_requests_user_idx" to table: "privacy_export_requests"
CREATE INDEX "privacy_export_requests_user_idx" ON "privacy"."privacy_export_requests" ("user_id");
-- Create "org_security_policy" table
CREATE TABLE "security"."org_security_policy" (
  "org_id" uuid NOT NULL,
  "mfa_required" boolean NOT NULL DEFAULT false,
  "mfa_grace_hours" integer NOT NULL DEFAULT 48,
  "updated_by_user_id" uuid NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id")
);
-- Create index "org_security_policy_org_idx" to table: "org_security_policy"
CREATE UNIQUE INDEX "org_security_policy_org_idx" ON "security"."org_security_policy" ("org_id");
-- Create "security_events" table
CREATE TABLE "security"."security_events" (
  "id" uuid NOT NULL DEFAULT public.uuid_generate_v4(),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "event_type" text NOT NULL,
  "actor_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NULL,
  "capability" text NULL,
  "outcome" text NOT NULL,
  "ip" text NULL,
  "user_agent" text NULL,
  "request_id" text NULL,
  CONSTRAINT "security_events_id_occurred_at_pk" PRIMARY KEY ("id", "occurred_at"),
  CONSTRAINT "security_events_event_type_check" CHECK (event_type = ANY (ARRAY['auth.sign_in'::text, 'auth.sign_in_failed'::text, 'auth.sign_out'::text, 'auth.token_refreshed'::text, 'auth.password_changed'::text, 'auth.email_verified'::text, 'api_key.created'::text, 'api_key.revoked'::text, 'api_key.used'::text, 'billing.access_denied'::text, 'billing.auto_reload_updated'::text, 'billing.checkout_initiated'::text, 'billing.credits_purchased'::text, 'billing.payment_method_added'::text, 'billing.payment_method_default_changed'::text, 'billing.payment_method_removed'::text, 'billing.plan_changed'::text, 'billing.seats_changed'::text, 'billing.subscription_canceled'::text, 'billing.subscription_reactivated'::text, 'capability.invoke_allowed'::text, 'capability.invoke_denied'::text, 'capability.invoke_error'::text, 'organization.created'::text, 'workspace.created'::text, 'org.member_invited'::text, 'org.member_removed'::text, 'org.role_changed'::text, 'security.mfa_policy_updated'::text, 'security.session_revoked'::text, 'access.review_completed'::text, 'access.member_access_confirmed'::text, 'privacy.export_requested'::text, 'privacy.erasure_requested'::text, 'privacy.org_erasure_requested'::text])),
  CONSTRAINT "security_events_outcome_check" CHECK (outcome = ANY (ARRAY['allow'::text, 'deny'::text, 'error'::text, 'success'::text]))
);
-- Create index "security_events_org_occurred_idx" to table: "security_events"
CREATE INDEX "security_events_org_occurred_idx" ON "security"."security_events" ("org_id", "occurred_at");
-- Create index "security_events_type_occurred_idx" to table: "security_events"
CREATE INDEX "security_events_type_occurred_idx" ON "security"."security_events" ("event_type", "occurred_at");
-- Create "playbook_approvals" table
CREATE TABLE "workflow"."playbook_approvals" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "playbook_run_id" uuid NOT NULL,
  "step_run_id" uuid NOT NULL,
  "requested_from_user_id" uuid NULL,
  "requested_from_role_id" uuid NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "comments" text NULL,
  "expires_at" timestamptz NULL,
  "resolved_at" timestamptz NULL,
  "resolved_by_user_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "playbook_approvals_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "playbook_approvals_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text]))
);
-- Create index "playbook_approvals_run_idx" to table: "playbook_approvals"
CREATE INDEX "playbook_approvals_run_idx" ON "workflow"."playbook_approvals" ("playbook_run_id");
-- Create index "playbook_approvals_status_idx" to table: "playbook_approvals"
CREATE INDEX "playbook_approvals_status_idx" ON "workflow"."playbook_approvals" ("workspace_id", "status");
-- Create index "playbook_approvals_step_run_idx" to table: "playbook_approvals"
CREATE INDEX "playbook_approvals_step_run_idx" ON "workflow"."playbook_approvals" ("step_run_id");
-- Create "playbook_edges" table
CREATE TABLE "workflow"."playbook_edges" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "playbook_version_id" uuid NOT NULL,
  "source_step_id" uuid NOT NULL,
  "target_step_id" uuid NOT NULL,
  "edge_type" text NOT NULL DEFAULT 'default',
  "condition" jsonb NULL,
  "priority" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "playbook_edges_edge_type_check" CHECK (edge_type = ANY (ARRAY['default'::text, 'conditional'::text, 'on_error'::text, 'loop_back'::text, 'parallel'::text]))
);
-- Create index "playbook_edges_source_idx" to table: "playbook_edges"
CREATE INDEX "playbook_edges_source_idx" ON "workflow"."playbook_edges" ("source_step_id");
-- Create index "playbook_edges_version_idx" to table: "playbook_edges"
CREATE INDEX "playbook_edges_version_idx" ON "workflow"."playbook_edges" ("playbook_version_id");
-- Create index "playbook_edges_version_src_tgt_type_uniq" to table: "playbook_edges"
CREATE UNIQUE INDEX "playbook_edges_version_src_tgt_type_uniq" ON "workflow"."playbook_edges" ("playbook_version_id", "source_step_id", "target_step_id", "edge_type");
-- Create "playbook_events" table
CREATE TABLE "workflow"."playbook_events" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "playbook_run_id" uuid NOT NULL,
  "step_run_id" uuid NULL,
  "sequence" integer NOT NULL,
  "event_type" text NOT NULL,
  "event_data" jsonb NOT NULL DEFAULT '{}',
  "prev_event_hash" text NOT NULL,
  "event_hash" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "playbook_events_event_type_check" CHECK (event_type = ANY (ARRAY['run_started'::text, 'step_started'::text, 'agent_invoked'::text, 'tool_called'::text, 'tool_completed'::text, 'condition_evaluated'::text, 'approval_requested'::text, 'approval_resolved'::text, 'step_completed'::text, 'step_failed'::text, 'step_retried'::text, 'run_paused'::text, 'run_resumed'::text, 'run_completed'::text, 'run_failed'::text, 'run_cancelled'::text]))
);
-- Create index "playbook_events_occurred_idx" to table: "playbook_events"
CREATE INDEX "playbook_events_occurred_idx" ON "workflow"."playbook_events" ("org_id", "occurred_at");
-- Create index "playbook_events_run_idx" to table: "playbook_events"
CREATE INDEX "playbook_events_run_idx" ON "workflow"."playbook_events" ("playbook_run_id");
-- Create index "playbook_events_run_seq_uniq" to table: "playbook_events"
CREATE UNIQUE INDEX "playbook_events_run_seq_uniq" ON "workflow"."playbook_events" ("playbook_run_id", "sequence");
-- Create "playbook_runs" table
CREATE TABLE "workflow"."playbook_runs" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "playbook_id" uuid NOT NULL,
  "playbook_version_id" uuid NOT NULL,
  "trigger_id" uuid NULL,
  "parent_run_id" uuid NULL,
  "parent_step_run_id" uuid NULL,
  "source" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "input" jsonb NULL,
  "output" jsonb NULL,
  "error" jsonb NULL,
  "context_id" uuid NULL,
  "inngest_run_id" text NULL,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  "started_by_user_id" uuid NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "playbook_runs_source_check" CHECK (source = ANY (ARRAY['api'::text, 'event'::text, 'schedule'::text, 'manual'::text, 'sub_playbook'::text])),
  CONSTRAINT "playbook_runs_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'paused'::text, 'waiting_approval'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))
);
-- Create index "playbook_runs_inngest_idx" to table: "playbook_runs"
CREATE INDEX "playbook_runs_inngest_idx" ON "workflow"."playbook_runs" ("inngest_run_id");
-- Create index "playbook_runs_parent_idx" to table: "playbook_runs"
CREATE INDEX "playbook_runs_parent_idx" ON "workflow"."playbook_runs" ("parent_run_id");
-- Create index "playbook_runs_playbook_created_idx" to table: "playbook_runs"
CREATE INDEX "playbook_runs_playbook_created_idx" ON "workflow"."playbook_runs" ("playbook_id", "created_at");
-- Create index "playbook_runs_ws_status_created_idx" to table: "playbook_runs"
CREATE INDEX "playbook_runs_ws_status_created_idx" ON "workflow"."playbook_runs" ("workspace_id", "status", "created_at");
-- Create "playbook_step_runs" table
CREATE TABLE "workflow"."playbook_step_runs" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "playbook_run_id" uuid NOT NULL,
  "playbook_step_id" uuid NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL,
  "input" jsonb NULL,
  "output" jsonb NULL,
  "error" jsonb NULL,
  "agent_version_id" uuid NULL,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "playbook_step_runs_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'waiting_approval'::text, 'completed'::text, 'failed'::text, 'skipped'::text, 'cancelled'::text]))
);
-- Create index "playbook_step_runs_run_idx" to table: "playbook_step_runs"
CREATE INDEX "playbook_step_runs_run_idx" ON "workflow"."playbook_step_runs" ("playbook_run_id");
-- Create index "playbook_step_runs_run_step_attempt_uniq" to table: "playbook_step_runs"
CREATE UNIQUE INDEX "playbook_step_runs_run_step_attempt_uniq" ON "workflow"."playbook_step_runs" ("playbook_run_id", "playbook_step_id", "attempt");
-- Create index "playbook_step_runs_step_idx" to table: "playbook_step_runs"
CREATE INDEX "playbook_step_runs_step_idx" ON "workflow"."playbook_step_runs" ("playbook_step_id");
-- Create "playbook_steps" table
CREATE TABLE "workflow"."playbook_steps" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "playbook_version_id" uuid NOT NULL,
  "step_key" public.citext NOT NULL,
  "name" text NOT NULL,
  "step_type" text NOT NULL,
  "is_async" boolean NOT NULL DEFAULT false,
  "exit_on_error" boolean NOT NULL DEFAULT true,
  "timeout_seconds" integer NULL,
  "retry_policy" jsonb NULL,
  "position_x" integer NULL,
  "position_y" integer NULL,
  "config" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "playbook_steps_step_type_check" CHECK (step_type = ANY (ARRAY['agent'::text, 'prompt'::text, 'tool'::text, 'condition'::text, 'approval'::text, 'human_input'::text, 'transform'::text, 'loop'::text, 'parallel'::text, 'delay'::text, 'webhook'::text, 'sub_playbook'::text, 'knowledge_search'::text, 'code_execution'::text]))
);
-- Create index "playbook_steps_version_idx" to table: "playbook_steps"
CREATE INDEX "playbook_steps_version_idx" ON "workflow"."playbook_steps" ("playbook_version_id");
-- Create index "playbook_steps_version_key_uniq" to table: "playbook_steps"
CREATE UNIQUE INDEX "playbook_steps_version_key_uniq" ON "workflow"."playbook_steps" ("playbook_version_id", "step_key");
-- Create "playbook_triggers" table
CREATE TABLE "workflow"."playbook_triggers" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "playbook_id" uuid NOT NULL,
  "pinned_version_id" uuid NULL,
  "trigger_type" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}',
  "is_enabled" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("id"),
  CONSTRAINT "playbook_triggers_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "playbook_triggers_trigger_type_check" CHECK (trigger_type = ANY (ARRAY['event'::text, 'schedule'::text, 'api'::text]))
);
-- Create index "playbook_triggers_dispatch_idx" to table: "playbook_triggers"
CREATE INDEX "playbook_triggers_dispatch_idx" ON "workflow"."playbook_triggers" ("workspace_id", "trigger_type") WHERE (is_enabled = true);
-- Create index "playbook_triggers_org_idx" to table: "playbook_triggers"
CREATE INDEX "playbook_triggers_org_idx" ON "workflow"."playbook_triggers" ("org_id", "workspace_id");
-- Create index "playbook_triggers_playbook_idx" to table: "playbook_triggers"
CREATE INDEX "playbook_triggers_playbook_idx" ON "workflow"."playbook_triggers" ("playbook_id");
-- Create "playbook_versions" table
CREATE TABLE "workflow"."playbook_versions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "playbook_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "change_summary" text NULL,
  "is_published" boolean NOT NULL DEFAULT false,
  "published_at" timestamptz NULL,
  "graph_hash" text NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "playbook_versions_playbook_idx" to table: "playbook_versions"
CREATE INDEX "playbook_versions_playbook_idx" ON "workflow"."playbook_versions" ("playbook_id");
-- Create index "playbook_versions_playbook_version_uniq" to table: "playbook_versions"
CREATE UNIQUE INDEX "playbook_versions_playbook_version_uniq" ON "workflow"."playbook_versions" ("playbook_id", "version");
-- Create index "playbook_versions_published_idx" to table: "playbook_versions"
CREATE INDEX "playbook_versions_published_idx" ON "workflow"."playbook_versions" ("playbook_id", "is_published");
-- Create "playbooks" table
CREATE TABLE "workflow"."playbooks" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "description" text NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "active_version_id" uuid NULL,
  "tags" jsonb NOT NULL DEFAULT '[]',
  "visibility" text NOT NULL DEFAULT 'workspace',
  PRIMARY KEY ("id"),
  CONSTRAINT "playbooks_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "playbooks_slug_check" CHECK (slug OPERATOR(public.~) '^[a-z0-9]+(-[a-z0-9]+)*$'::public.citext),
  CONSTRAINT "playbooks_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])),
  CONSTRAINT "playbooks_visibility_check" CHECK (visibility = ANY (ARRAY['private'::text, 'workspace'::text, 'organization'::text, 'marketplace'::text]))
);
-- Create index "playbooks_org_idx" to table: "playbooks"
CREATE INDEX "playbooks_org_idx" ON "workflow"."playbooks" ("org_id", "workspace_id");
-- Create index "playbooks_status_idx" to table: "playbooks"
CREATE INDEX "playbooks_status_idx" ON "workflow"."playbooks" ("workspace_id", "status");
-- Create index "playbooks_workspace_slug_uniq" to table: "playbooks"
CREATE UNIQUE INDEX "playbooks_workspace_slug_uniq" ON "workflow"."playbooks" ("workspace_id", "slug") WHERE (deleted_at IS NULL);
-- Create "workspace_users" table
CREATE TABLE "workspace"."workspace_users" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "permissions" jsonb NOT NULL DEFAULT '{}',
  "joined_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "workspace_users_public_id_unique" UNIQUE ("public_id")
);
-- Create index "workspace_users_user_idx" to table: "workspace_users"
CREATE INDEX "workspace_users_user_idx" ON "workspace"."workspace_users" ("user_id");
-- Create index "workspace_users_workspace_user_idx" to table: "workspace_users"
CREATE UNIQUE INDEX "workspace_users_workspace_user_idx" ON "workspace"."workspace_users" ("workspace_id", "user_id");
-- Create "workspaces" table
CREATE TABLE "workspace"."workspaces" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "default_graph_id" uuid NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  "default_text_tier" "auth"."model_tier" NULL,
  "default_text_model" text NULL,
  "default_image_model" text NULL,
  "default_video_model" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "workspaces_public_id_unique" UNIQUE ("public_id")
);
-- Create index "workspaces_org_idx" to table: "workspaces"
CREATE INDEX "workspaces_org_idx" ON "workspace"."workspaces" ("org_id");
-- Create index "workspaces_org_slug_idx" to table: "workspaces"
CREATE UNIQUE INDEX "workspaces_org_slug_idx" ON "workspace"."workspaces" ("org_id", "slug");
-- Create "agent_versions" table
CREATE TABLE "agent"."agent_versions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "agent_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "is_published" boolean NOT NULL DEFAULT false,
  "checksum" text NULL,
  "config" jsonb NOT NULL DEFAULT '{}',
  "created_by_user_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agent"."agents" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "agent_versions_agent_idx" to table: "agent_versions"
CREATE INDEX "agent_versions_agent_idx" ON "agent"."agent_versions" ("agent_id");
-- Create index "agent_versions_agent_version_uniq" to table: "agent_versions"
CREATE UNIQUE INDEX "agent_versions_agent_version_uniq" ON "agent"."agent_versions" ("agent_id", "version");
-- Create "agent_executions" table
CREATE TABLE "agent"."agent_executions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "agent_version_id" uuid NOT NULL,
  "origin_type" text NOT NULL,
  "origin_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'planning',
  "input_payload" jsonb NOT NULL,
  "output_payload" jsonb NULL,
  "failure_reason" text NULL,
  "started_at" timestamptz NULL,
  "completed_at" timestamptz NULL,
  "latency_ms" bigint NULL,
  "input_tokens" integer NULL,
  "output_tokens" integer NULL,
  "estimated_cost_usd" numeric(10,6) NULL,
  "synced_to_graph_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_executions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agent_executions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agent"."agents" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_executions_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "agent"."agent_versions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_executions_status_check" CHECK (status = ANY (ARRAY['planning'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))
);
-- Create index "agent_executions_agent_idx" to table: "agent_executions"
CREATE INDEX "agent_executions_agent_idx" ON "agent"."agent_executions" ("agent_id");
-- Create index "agent_executions_created_at_idx" to table: "agent_executions"
CREATE INDEX "agent_executions_created_at_idx" ON "agent"."agent_executions" ("created_at");
-- Create index "agent_executions_org_status_idx" to table: "agent_executions"
CREATE INDEX "agent_executions_org_status_idx" ON "agent"."agent_executions" ("org_id", "workspace_id", "status");
-- Create index "agent_executions_origin_idx" to table: "agent_executions"
CREATE INDEX "agent_executions_origin_idx" ON "agent"."agent_executions" ("origin_type", "origin_id");
-- Create "agent_execution_steps" table
CREATE TABLE "agent"."agent_execution_steps" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "execution_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "step_number" integer NOT NULL,
  "step_type" text NOT NULL,
  "status" text NOT NULL,
  "input_payload" jsonb NOT NULL,
  "output_payload" jsonb NULL,
  "failure_reason" text NULL,
  "latency_ms" bigint NULL,
  "input_tokens" integer NULL,
  "output_tokens" integer NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_execution_steps_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agent_execution_steps_execution_id_agent_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "agent"."agent_executions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_execution_steps_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))
);
-- Create index "agent_execution_steps_execution_idx" to table: "agent_execution_steps"
CREATE INDEX "agent_execution_steps_execution_idx" ON "agent"."agent_execution_steps" ("execution_id");
-- Create index "agent_execution_steps_org_idx" to table: "agent_execution_steps"
CREATE INDEX "agent_execution_steps_org_idx" ON "agent"."agent_execution_steps" ("org_id", "workspace_id");
-- Create "agent_tool_calls" table
CREATE TABLE "agent"."agent_tool_calls" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "execution_step_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "tool_type" text NOT NULL,
  "request_payload" jsonb NOT NULL,
  "response_payload" jsonb NULL,
  "status" text NOT NULL,
  "latency_ms" bigint NULL,
  "input_tokens" integer NULL,
  "output_tokens" integer NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "agent_tool_calls_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "agent_tool_calls_execution_step_id_agent_execution_steps_id_fk" FOREIGN KEY ("execution_step_id") REFERENCES "agent"."agent_execution_steps" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "agent_tool_calls_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text]))
);
-- Create index "agent_tool_calls_org_idx" to table: "agent_tool_calls"
CREATE INDEX "agent_tool_calls_org_idx" ON "agent"."agent_tool_calls" ("org_id", "workspace_id");
-- Create index "agent_tool_calls_step_idx" to table: "agent_tool_calls"
CREATE INDEX "agent_tool_calls_step_idx" ON "agent"."agent_tool_calls" ("execution_step_id");
-- Create index "agent_tool_calls_tool_idx" to table: "agent_tool_calls"
CREATE INDEX "agent_tool_calls_tool_idx" ON "agent"."agent_tool_calls" ("tool_name");
-- Create "organizations" table
CREATE TABLE "org"."organizations" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "avatar_url" text NULL,
  "plan_type" text NOT NULL,
  "status" text NOT NULL,
  "type" text NOT NULL DEFAULT 'business',
  "website" text NULL,
  "industry" text NULL,
  "employee_size" text NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "organizations_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "organizations_employee_size_check" CHECK ((employee_size IS NULL) OR (employee_size = ANY (ARRAY['1'::text, '2-10'::text, '11-50'::text, '51-200'::text, '201-500'::text, '501-1000'::text, '1001-5000'::text, '5001-10000'::text, '10000+'::text]))),
  CONSTRAINT "organizations_status_check" CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text])),
  CONSTRAINT "organizations_type_check" CHECK (type = ANY (ARRAY['personal'::text, 'business'::text]))
);
-- Create index "organizations_slug_idx" to table: "organizations"
CREATE UNIQUE INDEX "organizations_slug_idx" ON "org"."organizations" ("slug");
-- Create index "organizations_status_idx" to table: "organizations"
CREATE INDEX "organizations_status_idx" ON "org"."organizations" ("status");
-- Create "billing_disputes" table
CREATE TABLE "billing"."billing_disputes" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "stripe_dispute_id" text NOT NULL,
  "stripe_charge_id" text NULL,
  "payment_intent_id" text NULL,
  "amount_cents" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "reason" text NULL,
  "status" text NOT NULL,
  "clawed_back_cents" bigint NOT NULL DEFAULT 0,
  "resolved_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "billing_disputes_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "billing_disputes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "billing_disputes_org_idx" to table: "billing_disputes"
CREATE INDEX "billing_disputes_org_idx" ON "billing"."billing_disputes" ("org_id", "status");
-- Create index "billing_disputes_stripe_dispute_idx" to table: "billing_disputes"
CREATE UNIQUE INDEX "billing_disputes_stripe_dispute_idx" ON "billing"."billing_disputes" ("stripe_dispute_id");
-- Create "credit_balances" table
CREATE TABLE "billing"."credit_balances" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "balance_cents" bigint NOT NULL DEFAULT 0,
  "last_event_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "credit_balances_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "credit_balances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "credit_balances_balance_non_negative" CHECK (balance_cents >= 0)
);
-- Create index "credit_balances_org_idx" to table: "credit_balances"
CREATE UNIQUE INDEX "credit_balances_org_idx" ON "billing"."credit_balances" ("org_id");
-- Create "credit_ledger" table
CREATE TABLE "billing"."credit_ledger" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "delta_cents" bigint NOT NULL,
  "reason" text NOT NULL,
  "reference_type" text NULL,
  "reference_id" uuid NULL,
  "created_by_user_id" uuid NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "credit_ledger_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "credit_ledger_delta_non_zero" CHECK (delta_cents <> 0)
);
-- Create index "credit_ledger_grant_idempotency_idx" to table: "credit_ledger"
CREATE UNIQUE INDEX "credit_ledger_grant_idempotency_idx" ON "billing"."credit_ledger" ("org_id", "reason", "reference_type", "reference_id") WHERE ((reference_type IS NOT NULL) AND (reference_id IS NOT NULL));
-- Create index "credit_ledger_org_created_idx" to table: "credit_ledger"
CREATE INDEX "credit_ledger_org_created_idx" ON "billing"."credit_ledger" ("org_id", "created_at");
-- Create "credit_lots" table
CREATE TABLE "billing"."credit_lots" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "source" text NOT NULL,
  "original_cents" bigint NOT NULL,
  "remaining_cents" bigint NOT NULL,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "credit_lots_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "credit_lots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "credit_lots_remaining_le_original" CHECK (remaining_cents <= original_cents),
  CONSTRAINT "credit_lots_remaining_non_negative" CHECK (remaining_cents >= 0),
  CONSTRAINT "credit_lots_source_check" CHECK (source = ANY (ARRAY['free_grant'::text, 'subscription'::text, 'purchase'::text]))
);
-- Create index "credit_lots_org_expiry_idx" to table: "credit_lots"
CREATE INDEX "credit_lots_org_expiry_idx" ON "billing"."credit_lots" ("org_id", "expires_at");
-- Create "plans" table
CREATE TABLE "billing"."plans" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "tier" text NOT NULL,
  "stripe_product_id" text NOT NULL,
  "stripe_price_id_monthly" text NULL,
  "stripe_price_id_annual" text NULL,
  "monthly_cents" integer NOT NULL,
  "annual_cents" integer NULL,
  "included_credit_cents" integer NOT NULL DEFAULT 0,
  "included_seats" integer NOT NULL DEFAULT 1,
  "features" jsonb NOT NULL DEFAULT '{}',
  "is_public" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "plans_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "plans_tier_check" CHECK (tier = ANY (ARRAY['free'::text, 'build'::text, 'scale'::text, 'enterprise'::text]))
);
-- Create index "plans_slug_idx" to table: "plans"
CREATE UNIQUE INDEX "plans_slug_idx" ON "billing"."plans" ("slug");
-- Create "subscriptions" table
CREATE TABLE "billing"."subscriptions" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "status" text NOT NULL,
  "billing_interval" text NOT NULL,
  "current_period_start" timestamptz NOT NULL,
  "current_period_end" timestamptz NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "canceled_at" timestamptz NULL,
  "trial_end" timestamptz NULL,
  "seat_count" integer NOT NULL DEFAULT 1,
  PRIMARY KEY ("id"),
  CONSTRAINT "subscriptions_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "billing"."plans" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "subscriptions_billing_interval_check" CHECK (billing_interval = ANY (ARRAY['month'::text, 'year'::text])),
  CONSTRAINT "subscriptions_status_check" CHECK (status = ANY (ARRAY['active'::text, 'past_due'::text, 'canceled'::text, 'trialing'::text, 'unpaid'::text, 'incomplete'::text, 'incomplete_expired'::text, 'paused'::text]))
);
-- Create index "subscriptions_org_active_idx" to table: "subscriptions"
CREATE UNIQUE INDEX "subscriptions_org_active_idx" ON "billing"."subscriptions" ("org_id") WHERE (status = 'active'::text);
-- Create index "subscriptions_org_status_idx" to table: "subscriptions"
CREATE INDEX "subscriptions_org_status_idx" ON "billing"."subscriptions" ("org_id", "status");
-- Create index "subscriptions_stripe_sub_idx" to table: "subscriptions"
CREATE UNIQUE INDEX "subscriptions_stripe_sub_idx" ON "billing"."subscriptions" ("stripe_subscription_id");
-- Create "invoices" table
CREATE TABLE "billing"."invoices" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "subscription_id" uuid NULL,
  "stripe_invoice_id" text NOT NULL,
  "number" text NULL,
  "status" text NOT NULL,
  "amount_due_cents" integer NOT NULL,
  "amount_paid_cents" integer NOT NULL DEFAULT 0,
  "amount_remaining_cents" integer NOT NULL,
  "currency" text NOT NULL DEFAULT 'usd',
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "due_at" timestamptz NULL,
  "paid_at" timestamptz NULL,
  "hosted_invoice_url" text NULL,
  "invoice_pdf_url" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "invoices_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "invoices_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'open'::text, 'paid'::text, 'uncollectible'::text, 'void'::text]))
);
-- Create index "invoices_org_idx" to table: "invoices"
CREATE INDEX "invoices_org_idx" ON "billing"."invoices" ("org_id", "status");
-- Create index "invoices_stripe_inv_idx" to table: "invoices"
CREATE UNIQUE INDEX "invoices_stripe_inv_idx" ON "billing"."invoices" ("stripe_invoice_id");
-- Create "invoice_line_items" table
CREATE TABLE "billing"."invoice_line_items" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "invoice_id" uuid NOT NULL,
  "description" text NOT NULL,
  "quantity" numeric(18,4) NOT NULL,
  "unit_amount_cents" integer NOT NULL,
  "total_cents" integer NOT NULL,
  "metric" text NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "billing"."invoices" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "invoice_line_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "invoice_line_items_invoice_idx" to table: "invoice_line_items"
CREATE INDEX "invoice_line_items_invoice_idx" ON "billing"."invoice_line_items" ("invoice_id");
-- Create index "invoice_line_items_org_idx" to table: "invoice_line_items"
CREATE INDEX "invoice_line_items_org_idx" ON "billing"."invoice_line_items" ("org_id");
-- Create "org_billing_profiles" table
CREATE TABLE "billing"."org_billing_profiles" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "billing_email" public.citext NULL,
  "address_line1" text NULL,
  "address_line2" text NULL,
  "address_city" text NULL,
  "address_region" text NULL,
  "address_postal_code" text NULL,
  "address_country" text NULL,
  "address_place_id" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "org_billing_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "org_billing_profiles_org_idx" to table: "org_billing_profiles"
CREATE UNIQUE INDEX "org_billing_profiles_org_idx" ON "billing"."org_billing_profiles" ("org_id");
-- Create "org_billing_settings" table
CREATE TABLE "billing"."org_billing_settings" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "org_id" uuid NOT NULL,
  "auto_reload_enabled" boolean NOT NULL DEFAULT false,
  "auto_reload_threshold_cents" bigint NOT NULL DEFAULT 500,
  "auto_reload_amount_cents" bigint NOT NULL DEFAULT 2000,
  "auto_reload_payment_method_id" text NULL,
  "last_auto_reload_at" timestamptz NULL,
  "low_balance_threshold_cents" bigint NOT NULL DEFAULT 500,
  "dunning_state" text NOT NULL DEFAULT 'active',
  "delinquent_since" timestamptz NULL,
  "grace_ends_at" timestamptz NULL,
  "suspended_at" timestamptz NULL,
  "last_dunning_notified_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "org_billing_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "org_billing_settings_dunning_state_check" CHECK (dunning_state = ANY (ARRAY['active'::text, 'grace'::text, 'suspended'::text]))
);
-- Create index "org_billing_settings_org_idx" to table: "org_billing_settings"
CREATE UNIQUE INDEX "org_billing_settings_org_idx" ON "billing"."org_billing_settings" ("org_id");
-- Create "payment_methods" table
CREATE TABLE "billing"."payment_methods" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "stripe_payment_method_id" text NOT NULL,
  "type" text NOT NULL,
  "brand" text NULL,
  "last4" text NULL,
  "exp_month" integer NULL,
  "exp_year" integer NULL,
  "is_default" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("id"),
  CONSTRAINT "payment_methods_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "payment_methods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "payment_methods_org_idx" to table: "payment_methods"
CREATE INDEX "payment_methods_org_idx" ON "billing"."payment_methods" ("org_id");
-- Create index "payment_methods_stripe_pm_idx" to table: "payment_methods"
CREATE UNIQUE INDEX "payment_methods_stripe_pm_idx" ON "billing"."payment_methods" ("stripe_payment_method_id");
-- Create "stripe_events" table
CREATE TABLE "billing"."stripe_events" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "stripe_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "api_version" text NULL,
  "payload" jsonb NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id")
);
-- Create index "stripe_events_stripe_event_idx" to table: "stripe_events"
CREATE UNIQUE INDEX "stripe_events_stripe_event_idx" ON "billing"."stripe_events" ("stripe_event_id");
-- Create index "stripe_events_type_idx" to table: "stripe_events"
CREATE INDEX "stripe_events_type_idx" ON "billing"."stripe_events" ("event_type");
-- Create "stripe_event_processing" table
CREATE TABLE "billing"."stripe_event_processing" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "stripe_event_id" uuid NOT NULL,
  "processed_at" timestamptz NULL,
  "processing_error" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "stripe_event_processing_stripe_event_id_stripe_events_id_fk" FOREIGN KEY ("stripe_event_id") REFERENCES "billing"."stripe_events" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "stripe_event_processing_event_idx" to table: "stripe_event_processing"
CREATE UNIQUE INDEX "stripe_event_processing_event_idx" ON "billing"."stripe_event_processing" ("stripe_event_id");
-- Create "usage_records" table
CREATE TABLE "billing"."usage_records" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "metric" text NOT NULL,
  "quantity" numeric(20,6) NOT NULL,
  "unit_cost_micros" bigint NOT NULL,
  "total_cost_micros" bigint NOT NULL,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "source_query_id" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "usage_records_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "usage_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  CONSTRAINT "usage_records_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "billing"."subscriptions" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION
);
-- Create index "usage_records_org_idx" to table: "usage_records"
CREATE INDEX "usage_records_org_idx" ON "billing"."usage_records" ("org_id");
-- Create index "usage_records_sub_metric_period_idx" to table: "usage_records"
CREATE UNIQUE INDEX "usage_records_sub_metric_period_idx" ON "billing"."usage_records" ("subscription_id", "metric", "period_start", "period_end");
-- Create "users" table
CREATE TABLE "auth"."users" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "email" public.citext NOT NULL,
  "username" public.citext NULL,
  "display_name" text NULL,
  "avatar_url" text NULL,
  "status" text NOT NULL,
  "email_verified" boolean NOT NULL DEFAULT false,
  "email_verified_at" timestamptz NULL,
  "last_login_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "users_public_id_unique" UNIQUE ("public_id")
);
-- Create index "users_email_idx" to table: "users"
CREATE UNIQUE INDEX "users_email_idx" ON "auth"."users" ("email");
-- Create index "users_username_idx" to table: "users"
CREATE UNIQUE INDEX "users_username_idx" ON "auth"."users" ("username");
-- Create "user_preferences" table
CREATE TABLE "auth"."user_preferences" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "user_id" uuid NOT NULL,
  "font_size" "auth"."font_size" NOT NULL DEFAULT 'medium',
  "density" "auth"."density" NOT NULL DEFAULT 'comfortable',
  "enter_to_submit" boolean NOT NULL DEFAULT false,
  "pending_prompt_behavior" "auth"."pending_prompt_behavior" NOT NULL DEFAULT 'queue',
  "default_text_tier" "auth"."model_tier" NULL,
  "default_text_model" text NULL,
  "default_image_model" text NULL,
  "default_video_model" text NULL,
  "theme" text NOT NULL DEFAULT 'system',
  "language" text NOT NULL DEFAULT 'en',
  "timezone" text NOT NULL DEFAULT 'UTC',
  "notification_settings" jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY ("id"),
  CONSTRAINT "user_preferences_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Create index "user_preferences_user_id_idx" to table: "user_preferences"
CREATE UNIQUE INDEX "user_preferences_user_id_idx" ON "auth"."user_preferences" ("user_id");
