-- Consolidated baseline: complete schema from all migrations 0000-0030
-- Applied successfully in sequence; this file contains the final state
-- 0000_baseline.sql
--
-- Single squashed baseline of the Oxagen Postgres schema. Rebaselined from the
-- prior incremental migrations (0000_baseline … 0009_conversation_archive_soft_delete)
-- into one final-state migration. Safe because no environment was live with
-- customer data at rebaseline time (prod was reset from this file).
--
-- Represents the FINAL schema state: the dead `organization` schema already
-- dropped (0006), reconciled columns (0005), content + conversation soft-delete
-- (0007/0009), org type + billing profile (0003), generated assets (0002), and
-- user/workspace model & UX preferences (0004) all folded in. Includes the
-- required extensions (citext, ltree, pgcrypto, uuid-ossp), the
-- public.uuid_generate_v7() fallback function, and all 14 schemas, 65 tables,
-- enums, constraints, and indexes.
--
-- Generated via `pg_dump --schema-only --no-owner --no-privileges` of a database
-- built by applying every prior migration in order, then verified to provision a
-- fresh database with zero errors.
--
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: agent; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS agent;


--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS auth;


--
-- Name: billing; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS billing;


--
-- Name: chat; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS chat;


--
-- Name: content; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS content;


--
-- Name: evaluation; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS evaluation;


--
-- Name: event; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS event;


--
-- Name: execution; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS execution;


--
-- Name: graph; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS graph;


--
-- Name: integration; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS integration;


--
-- Name: org; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS org;


--
-- Name: security; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS security;


--
-- Name: workflow; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS workflow;


--
-- Name: workspace; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS workspace;


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: ltree; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA public;


--
-- Name: EXTENSION ltree; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION ltree IS 'data type for hierarchical tree-like structures';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: density; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.density AS ENUM (
    'compact',
    'comfortable',
    'spacious'
);


--
-- Name: font_size; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.font_size AS ENUM (
    'small',
    'medium',
    'large'
);


--
-- Name: model_tier; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.model_tier AS ENUM (
    'fast',
    'balanced',
    'precise'
);


--
-- Name: pending_prompt_behavior; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.pending_prompt_behavior AS ENUM (
    'queue',
    'interrupt'
);


--
-- Name: uuid_generate_v7(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.uuid_generate_v7() RETURNS uuid
    LANGUAGE plpgsql
    AS $$
      declare
        unix_ts_ms bytea;
        uuid_bytes bytea;
      begin
        -- 48-bit big-endian unix timestamp (milliseconds) in the first 6 bytes.
        unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
        -- 10 random bytes fill the remainder.
        uuid_bytes := unix_ts_ms || gen_random_bytes(10);
        -- Version 7 in the high nibble of byte 6.
        uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
        -- RFC 4122 variant (10xx) in the high bits of byte 8.
        uuid_bytes := set_byte(uuid_bytes, 8, (b'10' || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
        return encode(uuid_bytes, 'hex')::uuid;
      end
      $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_versions; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.agent_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    version_number integer NOT NULL,
    is_latest boolean DEFAULT false NOT NULL,
    parent_version_id uuid,
    published_at timestamp with time zone,
    input_schema jsonb NOT NULL,
    output_schema jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    agent_id uuid NOT NULL,
    system_prompt text NOT NULL,
    model text NOT NULL,
    temperature numeric(3,2) NOT NULL,
    context_window integer,
    tool_choice_policy text NOT NULL,
    runtime_config jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: agents; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.agents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    name text NOT NULL,
    slug public.citext NOT NULL,
    description text,
    default_model text NOT NULL,
    is_system_agent boolean DEFAULT false NOT NULL
);


--
-- Name: approval_requests; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.approval_requests (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    execution_step_id uuid,
    tool_call_id uuid,
    message_id uuid NOT NULL,
    capability_name text NOT NULL,
    input_preview jsonb NOT NULL,
    risk_level public.citext NOT NULL,
    resolution public.citext,
    resolved_at timestamp with time zone,
    resolved_by_user_id uuid,
    note text,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT approval_requests_resolution_check CHECK (((resolution IS NULL) OR (resolution OPERATOR(public.=) ANY (ARRAY['approved'::public.citext, 'denied'::public.citext, 'expired'::public.citext])))),
    CONSTRAINT approval_requests_risk_level_check CHECK ((risk_level OPERATOR(public.=) ANY (ARRAY['low'::public.citext, 'medium'::public.citext, 'high'::public.citext])))
);


--
-- Name: background_tasks; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.background_tasks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    label text,
    inngest_run_id text NOT NULL,
    status public.citext NOT NULL,
    input_payload jsonb NOT NULL,
    result_payload jsonb,
    failure_reason text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT background_tasks_status_check CHECK ((status OPERATOR(public.=) ANY (ARRAY['pending'::public.citext, 'running'::public.citext, 'completed'::public.citext, 'failed'::public.citext, 'cancelled'::public.citext])))
);


--
-- Name: mcp_servers; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.mcp_servers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    transport_type text NOT NULL,
    endpoint_url text NOT NULL,
    auth_strategy text NOT NULL,
    health_status text NOT NULL,
    last_healthcheck_at timestamp with time zone,
    auth_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    discovered_tools jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: plan_steps; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.plan_steps (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    execution_step_id uuid NOT NULL,
    plan_step_key text NOT NULL,
    summary text NOT NULL,
    intent text NOT NULL,
    capability_name text,
    input_preview jsonb,
    depends_on jsonb DEFAULT '[]'::jsonb NOT NULL,
    status public.citext NOT NULL,
    CONSTRAINT plan_steps_status_check CHECK ((status OPERATOR(public.=) ANY (ARRAY['pending'::public.citext, 'approved'::public.citext, 'denied'::public.citext, 'completed'::public.citext, 'failed'::public.citext])))
);


--
-- Name: skill_versions; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.skill_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    version_number integer NOT NULL,
    is_latest boolean DEFAULT false NOT NULL,
    parent_version_id uuid,
    published_at timestamp with time zone,
    skill_id uuid NOT NULL,
    body text NOT NULL,
    references_payload jsonb DEFAULT '[]'::jsonb NOT NULL
);


--
-- Name: skills; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.skills (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    name text NOT NULL,
    slug public.citext NOT NULL,
    description text,
    source public.citext NOT NULL,
    CONSTRAINT skills_source_check CHECK ((source OPERATOR(public.=) ANY (ARRAY['builtin'::public.citext, 'tenant'::public.citext])))
);


--
-- Name: subagent_fanouts; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.subagent_fanouts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    parent_message_id uuid NOT NULL,
    inngest_event_id text,
    status public.citext NOT NULL,
    total_children integer NOT NULL,
    completed_children integer DEFAULT 0 NOT NULL,
    CONSTRAINT subagent_fanouts_status_check CHECK ((status OPERATOR(public.=) ANY (ARRAY['pending'::public.citext, 'running'::public.citext, 'completed'::public.citext, 'partial'::public.citext, 'timed_out'::public.citext])))
);


--
-- Name: subagent_runs; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.subagent_runs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    fanout_id uuid NOT NULL,
    child_message_id uuid NOT NULL,
    capability_name text NOT NULL,
    input_payload jsonb NOT NULL,
    output_payload jsonb,
    status public.citext NOT NULL,
    error_reason text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    CONSTRAINT subagent_runs_status_check CHECK ((status OPERATOR(public.=) ANY (ARRAY['pending'::public.citext, 'running'::public.citext, 'completed'::public.citext, 'failed'::public.citext])))
);


--
-- Name: tool_assignments; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.tool_assignments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    agent_version_id uuid NOT NULL,
    tool_version_id uuid NOT NULL,
    policy_config jsonb NOT NULL,
    is_enabled_in_workspace boolean DEFAULT true NOT NULL,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: tool_versions; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.tool_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    version_number integer NOT NULL,
    is_latest boolean DEFAULT false NOT NULL,
    parent_version_id uuid,
    published_at timestamp with time zone,
    tool_id uuid NOT NULL,
    input_schema jsonb NOT NULL,
    output_schema jsonb NOT NULL,
    runtime_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    execution_handler text NOT NULL,
    execution_mode text NOT NULL,
    timeout_seconds integer NOT NULL,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: tools; Type: TABLE; Schema: agent; Owner: -
--

CREATE TABLE agent.tools (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    slug public.citext NOT NULL,
    tool_type text NOT NULL,
    description text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    requires_approval boolean DEFAULT false NOT NULL,
    risk_level public.citext DEFAULT 'low'::public.citext NOT NULL,
    category text,
    CONSTRAINT tools_risk_level_check CHECK ((risk_level OPERATOR(public.=) ANY (ARRAY['low'::public.citext, 'medium'::public.citext, 'high'::public.citext])))
);


--
-- Name: accounts; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.accounts (
    id text NOT NULL,
    user_id uuid NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    access_token_enc bytea,
    refresh_token_enc bytea,
    id_token_enc bytea,
    token_kms_key_id text,
    access_token text,
    refresh_token text
);


--
-- Name: api_keys; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.api_keys (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    name text NOT NULL,
    scope jsonb NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone
);


--
-- Name: credentials; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.credentials (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    provider text NOT NULL,
    credential_type text NOT NULL,
    encrypted_payload bytea NOT NULL,
    kms_key_id text,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone
);


--
-- Name: sessions; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sessions (
    id text NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_preferences; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.user_preferences (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    user_id uuid NOT NULL,
    font_size auth.font_size DEFAULT 'medium'::auth.font_size NOT NULL,
    density auth.density DEFAULT 'comfortable'::auth.density NOT NULL,
    enter_to_submit boolean DEFAULT false NOT NULL,
    pending_prompt_behavior auth.pending_prompt_behavior DEFAULT 'queue'::auth.pending_prompt_behavior NOT NULL,
    default_text_tier auth.model_tier,
    default_text_model text,
    default_image_model text,
    default_video_model text
);


--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    email public.citext NOT NULL,
    username public.citext,
    display_name text,
    avatar_url text,
    status text NOT NULL,
    email_verified_at timestamp with time zone,
    last_login_at timestamp with time zone,
    email_verified boolean DEFAULT false NOT NULL
);


--
-- Name: verifications; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.verifications (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_disputes; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.billing_disputes (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    stripe_dispute_id text NOT NULL,
    stripe_charge_id text,
    payment_intent_id text,
    amount_cents integer NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    reason text,
    status text NOT NULL,
    clawed_back_cents bigint DEFAULT 0 NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: credit_balances; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.credit_balances (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    balance_cents bigint DEFAULT 0 NOT NULL,
    last_event_at timestamp with time zone,
    CONSTRAINT credit_balances_balance_non_negative CHECK ((balance_cents >= 0))
);


--
-- Name: credit_ledger; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.credit_ledger (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    org_id uuid NOT NULL,
    delta_cents bigint NOT NULL,
    reason text NOT NULL,
    reference_type text,
    reference_id uuid,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_ledger_delta_non_zero CHECK ((delta_cents <> 0)),
    CONSTRAINT credit_ledger_reason_check CHECK ((reason = ANY (ARRAY['grant_signup'::text, 'grant_plan_renewal'::text, 'grant_manual'::text, 'consume_execution'::text, 'consume_tool_call'::text, 'consume_token_overage'::text, 'refund'::text, 'adjustment'::text])))
);


--
-- Name: credit_lots; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.credit_lots (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    source text NOT NULL,
    original_cents bigint NOT NULL,
    remaining_cents bigint NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT credit_lots_remaining_le_original CHECK ((remaining_cents <= original_cents)),
    CONSTRAINT credit_lots_remaining_non_negative CHECK ((remaining_cents >= 0)),
    CONSTRAINT credit_lots_source_check CHECK ((source = ANY (ARRAY['free_grant'::text, 'subscription'::text, 'purchase'::text])))
);


--
-- Name: invoice_line_items; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.invoice_line_items (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    invoice_id uuid NOT NULL,
    description text NOT NULL,
    quantity numeric(18,4) NOT NULL,
    unit_amount_cents integer NOT NULL,
    total_cents integer NOT NULL,
    metric text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    org_id uuid NOT NULL
);


--
-- Name: invoices; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.invoices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    subscription_id uuid,
    stripe_invoice_id text NOT NULL,
    number text,
    status text NOT NULL,
    amount_due_cents integer NOT NULL,
    amount_paid_cents integer DEFAULT 0 NOT NULL,
    amount_remaining_cents integer NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    due_at timestamp with time zone,
    paid_at timestamp with time zone,
    hosted_invoice_url text,
    invoice_pdf_url text,
    CONSTRAINT invoices_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'paid'::text, 'void'::text, 'uncollectible'::text])))
);


--
-- Name: org_billing_profiles; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.org_billing_profiles (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    org_id uuid NOT NULL,
    billing_email public.citext,
    address_line1 text,
    address_line2 text,
    address_city text,
    address_region text,
    address_postal_code text,
    address_country text,
    address_place_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid
);


--
-- Name: org_billing_settings; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.org_billing_settings (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    org_id uuid NOT NULL,
    auto_reload_enabled boolean DEFAULT false NOT NULL,
    auto_reload_threshold_cents bigint DEFAULT 500 NOT NULL,
    auto_reload_amount_cents bigint DEFAULT 2000 NOT NULL,
    auto_reload_payment_method_id text,
    last_auto_reload_at timestamp with time zone,
    low_balance_threshold_cents bigint DEFAULT 500 NOT NULL,
    dunning_state text DEFAULT 'active'::text NOT NULL,
    delinquent_since timestamp with time zone,
    grace_ends_at timestamp with time zone,
    suspended_at timestamp with time zone,
    last_dunning_notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT org_billing_settings_dunning_state_check CHECK ((dunning_state = ANY (ARRAY['active'::text, 'grace'::text, 'suspended'::text])))
);


--
-- Name: payment_methods; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.payment_methods (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    org_id uuid NOT NULL,
    stripe_customer_id text NOT NULL,
    stripe_payment_method_id text NOT NULL,
    type text NOT NULL,
    brand text,
    last4 text,
    exp_month integer,
    exp_year integer,
    is_default boolean DEFAULT false NOT NULL
);


--
-- Name: plans; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.plans (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    name text NOT NULL,
    slug public.citext NOT NULL,
    tier text NOT NULL,
    stripe_product_id text NOT NULL,
    stripe_price_id_monthly text,
    stripe_price_id_annual text,
    monthly_cents integer NOT NULL,
    annual_cents integer,
    included_credit_cents integer DEFAULT 0 NOT NULL,
    included_seats integer DEFAULT 1 NOT NULL,
    features jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    CONSTRAINT plans_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'build'::text, 'scale'::text, 'enterprise'::text])))
);


--
-- Name: stripe_event_processing; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.stripe_event_processing (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    stripe_event_id uuid NOT NULL,
    processed_at timestamp with time zone,
    processing_error text
);


--
-- Name: stripe_events; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.stripe_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    stripe_event_id text NOT NULL,
    event_type text NOT NULL,
    api_version text,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscriptions; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.subscriptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    stripe_subscription_id text NOT NULL,
    stripe_customer_id text NOT NULL,
    status text NOT NULL,
    billing_interval text NOT NULL,
    current_period_start timestamp with time zone NOT NULL,
    current_period_end timestamp with time zone NOT NULL,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    canceled_at timestamp with time zone,
    trial_end timestamp with time zone,
    seat_count integer DEFAULT 1 NOT NULL,
    CONSTRAINT subscriptions_billing_interval_check CHECK ((billing_interval = ANY (ARRAY['month'::text, 'year'::text]))),
    CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'incomplete'::text, 'incomplete_expired'::text, 'unpaid'::text, 'paused'::text])))
);


--
-- Name: usage_records; Type: TABLE; Schema: billing; Owner: -
--

CREATE TABLE billing.usage_records (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    org_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    metric text NOT NULL,
    quantity numeric(20,6) NOT NULL,
    unit_cost_micros bigint NOT NULL,
    total_cost_micros bigint NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    source_query_id text
);


--
-- Name: conversations; Type: TABLE; Schema: chat; Owner: -
--

CREATE TABLE chat.conversations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    agent_version_id uuid,
    title text,
    status text NOT NULL,
    active_leaf_message_id uuid,
    archived_at timestamp with time zone,
    archived_by_user_id uuid,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid
);


--
-- Name: messages; Type: TABLE; Schema: chat; Owner: -
--

CREATE TABLE chat.messages (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    parent_message_id uuid,
    role text NOT NULL,
    content text NOT NULL,
    content_blocks jsonb NOT NULL,
    branch_reason text,
    is_active_in_branch boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.documents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    file_id uuid NOT NULL,
    folder_id uuid,
    title text NOT NULL,
    document_type text NOT NULL,
    embedding_status text NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid
);


--
-- Name: files; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.files (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    storage_provider text NOT NULL,
    storage_bucket text NOT NULL,
    storage_key text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    checksum_sha256 text NOT NULL,
    uploaded_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid
);


--
-- Name: generated_assets; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.generated_assets (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    access_policy text DEFAULT 'user'::text NOT NULL,
    status text DEFAULT 'ready'::text NOT NULL,
    storage_provider text NOT NULL,
    storage_key text NOT NULL,
    storage_url text,
    mime_type text NOT NULL,
    size_bytes bigint,
    prompt text NOT NULL,
    model text NOT NULL,
    conversation_id uuid,
    message_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT generated_assets_access_policy_check CHECK ((access_policy = ANY (ARRAY['user'::text, 'org'::text, 'public'::text]))),
    CONSTRAINT generated_assets_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text]))),
    CONSTRAINT generated_assets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);


--
-- Name: triggers; Type: TABLE; Schema: event; Owner: -
--

CREATE TABLE event.triggers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    event_type text NOT NULL,
    filter_expression jsonb NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL
);


--
-- Name: workflow_triggers; Type: TABLE; Schema: event; Owner: -
--

CREATE TABLE event.workflow_triggers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    trigger_id uuid NOT NULL,
    playbook_version_id uuid NOT NULL,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: execution_artifacts; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.execution_artifacts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    execution_id uuid NOT NULL,
    artifact_type text NOT NULL,
    document_id uuid,
    storage_uri text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: execution_steps; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.execution_steps (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    execution_id uuid NOT NULL,
    playbook_step_id uuid NOT NULL,
    agent_version_id uuid NOT NULL,
    attempt_number integer DEFAULT 1 NOT NULL,
    input_payload jsonb NOT NULL,
    output_payload jsonb,
    token_usage jsonb,
    latency_ms bigint,
    failure_reason text,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    CONSTRAINT execution_steps_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text])))
);


--
-- Name: executions; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.executions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    playbook_version_id uuid NOT NULL,
    trigger_event_id uuid,
    triggered_by_message_id uuid,
    started_by_user_id uuid,
    input_payload jsonb NOT NULL,
    output_payload jsonb,
    failure_reason text,
    CONSTRAINT executions_one_trigger_source CHECK ((NOT ((trigger_event_id IS NOT NULL) AND (triggered_by_message_id IS NOT NULL)))),
    CONSTRAINT executions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'timed_out'::text])))
);


--
-- Name: tool_calls; Type: TABLE; Schema: execution; Owner: -
--

CREATE TABLE execution.tool_calls (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    execution_step_id uuid NOT NULL,
    tool_version_id uuid NOT NULL,
    request_payload jsonb NOT NULL,
    response_payload jsonb,
    latency_ms bigint,
    token_usage jsonb,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: connections; Type: TABLE; Schema: integration; Owner: -
--

CREATE TABLE integration.connections (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    provider text NOT NULL,
    display_name text NOT NULL,
    credential_id uuid,
    status text NOT NULL,
    sync_enabled boolean DEFAULT true NOT NULL,
    last_sync_at timestamp with time zone,
    config jsonb NOT NULL
);


--
-- Name: access_requests; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.access_requests (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    org_id uuid NOT NULL,
    requester_id uuid NOT NULL,
    capability_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approver_id uuid,
    approved_at timestamp with time zone,
    ttl_seconds integer,
    justification text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT access_requests_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['org'::text, 'workspace'::text]))),
    CONSTRAINT access_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'expired'::text])))
);


--
-- Name: grants; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.grants (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    org_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    capability_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid NOT NULL,
    effect text NOT NULL,
    conditions_jsonb jsonb,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT grants_effect_check CHECK ((effect = ANY (ARRAY['allow'::text, 'deny'::text, 'require_approval'::text]))),
    CONSTRAINT grants_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['org'::text, 'workspace'::text])))
);


--
-- Name: iam_sessions; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.iam_sessions (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    org_id uuid NOT NULL,
    principal_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    ip text,
    ua text,
    idp_session_id text,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    revoke_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid
);


--
-- Name: invitations; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.invitations (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    email public.citext NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    invited_by_user_id uuid NOT NULL,
    accepted_user_id uuid,
    expires_at timestamp with time zone,
    CONSTRAINT invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: org_users; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.org_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    joined_at timestamp with time zone NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.organizations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    name text NOT NULL,
    slug public.citext NOT NULL,
    plan_type text NOT NULL,
    status text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    type text DEFAULT 'business'::text NOT NULL,
    website text,
    industry text,
    employee_size text,
    avatar_url text,
    CONSTRAINT organizations_employee_size_check CHECK (((employee_size IS NULL) OR (employee_size = ANY (ARRAY['1'::text, '2-10'::text, '11-50'::text, '51-200'::text, '201-500'::text, '501-1000'::text, '1001-5000'::text, '5001-10000'::text, '10000+'::text])))),
    CONSTRAINT organizations_type_check CHECK ((type = ANY (ARRAY['personal'::text, 'business'::text])))
);


--
-- Name: policies; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.policies (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    capability_id text NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid,
    effect text NOT NULL,
    enforced boolean DEFAULT false NOT NULL,
    conditions_jsonb jsonb,
    sensitivity_tag text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT policies_effect_check CHECK ((effect = ANY (ARRAY['allow'::text, 'deny'::text, 'require_approval'::text]))),
    CONSTRAINT policies_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['org'::text, 'workspace'::text])))
);


--
-- Name: principal_role_assignments; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.principal_role_assignments (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    principal_id uuid NOT NULL,
    role_id uuid NOT NULL,
    org_id uuid NOT NULL,
    workspace_id uuid,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone
);


--
-- Name: principals; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.principals (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    org_id uuid NOT NULL,
    workspace_id uuid,
    kind text NOT NULL,
    display_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    mfa_status text DEFAULT 'none'::text NOT NULL,
    idp_subject text,
    parent_user_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT principals_kind_check CHECK ((kind = ANY (ARRAY['human'::text, 'agent'::text, 'service'::text]))),
    CONSTRAINT principals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'deleted'::text])))
);


--
-- Name: role_grants; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.role_grants (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    org_id uuid NOT NULL,
    role_id uuid NOT NULL,
    capability_id text NOT NULL,
    effect text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT role_grants_effect_check CHECK ((effect = ANY (ARRAY['allow'::text, 'deny'::text, 'require_approval'::text])))
);


--
-- Name: roles; Type: TABLE; Schema: org; Owner: -
--

CREATE TABLE org.roles (
    id uuid DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()) NOT NULL,
    public_id public.citext NOT NULL,
    org_id uuid NOT NULL,
    scope_kind text NOT NULL,
    name text NOT NULL,
    description text,
    is_system_default boolean DEFAULT false NOT NULL,
    version text DEFAULT '1'::text NOT NULL,
    parent_role_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    CONSTRAINT roles_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['org'::text, 'workspace'::text])))
);


--
-- Name: security_events; Type: TABLE; Schema: security; Owner: -
--

CREATE TABLE security.security_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid,
    capability text,
    outcome text NOT NULL,
    ip text,
    user_agent text,
    request_id text,
    CONSTRAINT security_events_event_type_check CHECK ((event_type = ANY (ARRAY['auth.sign_in'::text, 'auth.sign_in_failed'::text, 'auth.sign_out'::text, 'auth.token_refreshed'::text, 'auth.password_changed'::text, 'auth.email_verified'::text, 'api_key.created'::text, 'api_key.revoked'::text, 'api_key.used'::text, 'capability.invoke_allowed'::text, 'capability.invoke_denied'::text, 'capability.invoke_error'::text, 'org.member_invited'::text, 'org.member_removed'::text, 'org.role_changed'::text]))),
    CONSTRAINT security_events_outcome_check CHECK ((outcome = ANY (ARRAY['allow'::text, 'deny'::text, 'error'::text, 'success'::text])))
);


--
-- Name: playbook_step_assignments; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.playbook_step_assignments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    playbook_step_id uuid NOT NULL,
    agent_version_id uuid NOT NULL,
    model_override text,
    max_retries integer DEFAULT 0 NOT NULL,
    timeout_seconds integer,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: playbook_steps; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.playbook_steps (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    input_schema jsonb NOT NULL,
    output_schema jsonb NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    playbook_version_id uuid NOT NULL,
    step_key text NOT NULL,
    step_type text NOT NULL,
    prompt_template_id uuid,
    execution_order integer,
    retry_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    timeout_policy jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: playbook_versions; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.playbook_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    version_number integer NOT NULL,
    is_latest boolean DEFAULT false NOT NULL,
    parent_version_id uuid,
    published_at timestamp with time zone,
    playbook_id uuid NOT NULL,
    entry_step_id uuid,
    graph_definition jsonb NOT NULL,
    is_active boolean DEFAULT false NOT NULL
);


--
-- Name: playbooks; Type: TABLE; Schema: workflow; Owner: -
--

CREATE TABLE workflow.playbooks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by_user_id uuid,
    name text NOT NULL,
    slug public.citext NOT NULL,
    description text
);


--
-- Name: folders; Type: TABLE; Schema: workspace; Owner: -
--

CREATE TABLE workspace.folders (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    parent_folder_id uuid,
    name text NOT NULL,
    path public.ltree NOT NULL
);


--
-- Name: workspace_users; Type: TABLE; Schema: workspace; Owner: -
--

CREATE TABLE workspace.workspace_users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    joined_at timestamp with time zone NOT NULL
);


--
-- Name: workspaces; Type: TABLE; Schema: workspace; Owner: -
--

CREATE TABLE workspace.workspaces (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    public_id public.citext NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_user_id uuid,
    updated_by_user_id uuid,
    org_id uuid NOT NULL,
    name text NOT NULL,
    slug public.citext NOT NULL,
    default_graph_id uuid,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    default_text_tier auth.model_tier,
    default_text_model text,
    default_image_model text,
    default_video_model text
);


--
-- Name: agent_versions agent_versions_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.agent_versions
    ADD CONSTRAINT agent_versions_pkey PRIMARY KEY (id);


--
-- Name: agent_versions agent_versions_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.agent_versions
    ADD CONSTRAINT agent_versions_public_id_key UNIQUE (public_id);


--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);


--
-- Name: agents agents_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.agents
    ADD CONSTRAINT agents_public_id_key UNIQUE (public_id);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: approval_requests approval_requests_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.approval_requests
    ADD CONSTRAINT approval_requests_public_id_key UNIQUE (public_id);


--
-- Name: background_tasks background_tasks_inngest_run_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.background_tasks
    ADD CONSTRAINT background_tasks_inngest_run_id_key UNIQUE (inngest_run_id);


--
-- Name: background_tasks background_tasks_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.background_tasks
    ADD CONSTRAINT background_tasks_pkey PRIMARY KEY (id);


--
-- Name: background_tasks background_tasks_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.background_tasks
    ADD CONSTRAINT background_tasks_public_id_key UNIQUE (public_id);


--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);


--
-- Name: mcp_servers mcp_servers_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.mcp_servers
    ADD CONSTRAINT mcp_servers_public_id_key UNIQUE (public_id);


--
-- Name: plan_steps plan_steps_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.plan_steps
    ADD CONSTRAINT plan_steps_pkey PRIMARY KEY (id);


--
-- Name: plan_steps plan_steps_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.plan_steps
    ADD CONSTRAINT plan_steps_public_id_key UNIQUE (public_id);


--
-- Name: skill_versions skill_versions_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.skill_versions
    ADD CONSTRAINT skill_versions_pkey PRIMARY KEY (id);


--
-- Name: skill_versions skill_versions_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.skill_versions
    ADD CONSTRAINT skill_versions_public_id_key UNIQUE (public_id);


--
-- Name: skills skills_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);


--
-- Name: skills skills_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.skills
    ADD CONSTRAINT skills_public_id_key UNIQUE (public_id);


--
-- Name: subagent_fanouts subagent_fanouts_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.subagent_fanouts
    ADD CONSTRAINT subagent_fanouts_pkey PRIMARY KEY (id);


--
-- Name: subagent_fanouts subagent_fanouts_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.subagent_fanouts
    ADD CONSTRAINT subagent_fanouts_public_id_key UNIQUE (public_id);


--
-- Name: subagent_runs subagent_runs_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.subagent_runs
    ADD CONSTRAINT subagent_runs_pkey PRIMARY KEY (id);


--
-- Name: subagent_runs subagent_runs_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.subagent_runs
    ADD CONSTRAINT subagent_runs_public_id_key UNIQUE (public_id);


--
-- Name: tool_assignments tool_assignments_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_assignments
    ADD CONSTRAINT tool_assignments_pkey PRIMARY KEY (id);


--
-- Name: tool_assignments tool_assignments_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_assignments
    ADD CONSTRAINT tool_assignments_public_id_key UNIQUE (public_id);


--
-- Name: tool_versions tool_versions_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_versions
    ADD CONSTRAINT tool_versions_pkey PRIMARY KEY (id);


--
-- Name: tool_versions tool_versions_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_versions
    ADD CONSTRAINT tool_versions_public_id_key UNIQUE (public_id);


--
-- Name: tools tools_pkey; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (id);


--
-- Name: tools tools_public_id_key; Type: CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tools
    ADD CONSTRAINT tools_public_id_key UNIQUE (public_id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_public_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.api_keys
    ADD CONSTRAINT api_keys_public_id_key UNIQUE (public_id);


--
-- Name: credentials credentials_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.credentials
    ADD CONSTRAINT credentials_pkey PRIMARY KEY (id);


--
-- Name: credentials credentials_public_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.credentials
    ADD CONSTRAINT credentials_public_id_key UNIQUE (public_id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_preferences user_preferences_public_id_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.user_preferences
    ADD CONSTRAINT user_preferences_public_id_unique UNIQUE (public_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_public_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_public_id_key UNIQUE (public_id);


--
-- Name: verifications verifications_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);


--
-- Name: billing_disputes billing_disputes_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.billing_disputes
    ADD CONSTRAINT billing_disputes_pkey PRIMARY KEY (id);


--
-- Name: billing_disputes billing_disputes_public_id_unique; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.billing_disputes
    ADD CONSTRAINT billing_disputes_public_id_unique UNIQUE (public_id);


--
-- Name: credit_balances credit_balances_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_balances
    ADD CONSTRAINT credit_balances_pkey PRIMARY KEY (id);


--
-- Name: credit_balances credit_balances_public_id_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_balances
    ADD CONSTRAINT credit_balances_public_id_key UNIQUE (public_id);


--
-- Name: credit_ledger credit_ledger_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_ledger
    ADD CONSTRAINT credit_ledger_pkey PRIMARY KEY (id);


--
-- Name: credit_lots credit_lots_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_lots
    ADD CONSTRAINT credit_lots_pkey PRIMARY KEY (id);


--
-- Name: credit_lots credit_lots_public_id_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_lots
    ADD CONSTRAINT credit_lots_public_id_key UNIQUE (public_id);


--
-- Name: invoice_line_items invoice_line_items_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice_line_items
    ADD CONSTRAINT invoice_line_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_public_id_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_public_id_key UNIQUE (public_id);


--
-- Name: org_billing_profiles org_billing_profiles_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.org_billing_profiles
    ADD CONSTRAINT org_billing_profiles_pkey PRIMARY KEY (id);


--
-- Name: org_billing_settings org_billing_settings_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.org_billing_settings
    ADD CONSTRAINT org_billing_settings_pkey PRIMARY KEY (id);


--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);


--
-- Name: payment_methods payment_methods_public_id_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.payment_methods
    ADD CONSTRAINT payment_methods_public_id_key UNIQUE (public_id);


--
-- Name: plans plans_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.plans
    ADD CONSTRAINT plans_pkey PRIMARY KEY (id);


--
-- Name: plans plans_public_id_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.plans
    ADD CONSTRAINT plans_public_id_key UNIQUE (public_id);


--
-- Name: stripe_event_processing stripe_event_processing_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.stripe_event_processing
    ADD CONSTRAINT stripe_event_processing_pkey PRIMARY KEY (id);


--
-- Name: stripe_events stripe_events_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.stripe_events
    ADD CONSTRAINT stripe_events_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_public_id_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.subscriptions
    ADD CONSTRAINT subscriptions_public_id_key UNIQUE (public_id);


--
-- Name: usage_records usage_records_pkey; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.usage_records
    ADD CONSTRAINT usage_records_pkey PRIMARY KEY (id);


--
-- Name: usage_records usage_records_public_id_key; Type: CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.usage_records
    ADD CONSTRAINT usage_records_public_id_key UNIQUE (public_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: chat; Owner: -
--

ALTER TABLE ONLY chat.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_public_id_key; Type: CONSTRAINT; Schema: chat; Owner: -
--

ALTER TABLE ONLY chat.conversations
    ADD CONSTRAINT conversations_public_id_key UNIQUE (public_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: chat; Owner: -
--

ALTER TABLE ONLY chat.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: messages messages_public_id_key; Type: CONSTRAINT; Schema: chat; Owner: -
--

ALTER TABLE ONLY chat.messages
    ADD CONSTRAINT messages_public_id_key UNIQUE (public_id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: documents documents_public_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.documents
    ADD CONSTRAINT documents_public_id_key UNIQUE (public_id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: files files_public_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.files
    ADD CONSTRAINT files_public_id_key UNIQUE (public_id);


--
-- Name: generated_assets generated_assets_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.generated_assets
    ADD CONSTRAINT generated_assets_pkey PRIMARY KEY (id);


--
-- Name: generated_assets generated_assets_public_id_unique; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.generated_assets
    ADD CONSTRAINT generated_assets_public_id_unique UNIQUE (public_id);


--
-- Name: triggers triggers_pkey; Type: CONSTRAINT; Schema: event; Owner: -
--

ALTER TABLE ONLY event.triggers
    ADD CONSTRAINT triggers_pkey PRIMARY KEY (id);


--
-- Name: triggers triggers_public_id_key; Type: CONSTRAINT; Schema: event; Owner: -
--

ALTER TABLE ONLY event.triggers
    ADD CONSTRAINT triggers_public_id_key UNIQUE (public_id);


--
-- Name: workflow_triggers workflow_triggers_pkey; Type: CONSTRAINT; Schema: event; Owner: -
--

ALTER TABLE ONLY event.workflow_triggers
    ADD CONSTRAINT workflow_triggers_pkey PRIMARY KEY (id);


--
-- Name: workflow_triggers workflow_triggers_public_id_key; Type: CONSTRAINT; Schema: event; Owner: -
--

ALTER TABLE ONLY event.workflow_triggers
    ADD CONSTRAINT workflow_triggers_public_id_key UNIQUE (public_id);


--
-- Name: execution_artifacts execution_artifacts_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.execution_artifacts
    ADD CONSTRAINT execution_artifacts_pkey PRIMARY KEY (id);


--
-- Name: execution_artifacts execution_artifacts_public_id_key; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.execution_artifacts
    ADD CONSTRAINT execution_artifacts_public_id_key UNIQUE (public_id);


--
-- Name: execution_steps execution_steps_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.execution_steps
    ADD CONSTRAINT execution_steps_pkey PRIMARY KEY (id);


--
-- Name: execution_steps execution_steps_public_id_key; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.execution_steps
    ADD CONSTRAINT execution_steps_public_id_key UNIQUE (public_id);


--
-- Name: executions executions_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.executions
    ADD CONSTRAINT executions_pkey PRIMARY KEY (id);


--
-- Name: executions executions_public_id_key; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.executions
    ADD CONSTRAINT executions_public_id_key UNIQUE (public_id);


--
-- Name: tool_calls tool_calls_pkey; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (id);


--
-- Name: tool_calls tool_calls_public_id_key; Type: CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.tool_calls
    ADD CONSTRAINT tool_calls_public_id_key UNIQUE (public_id);


--
-- Name: connections connections_pkey; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.connections
    ADD CONSTRAINT connections_pkey PRIMARY KEY (id);


--
-- Name: connections connections_public_id_key; Type: CONSTRAINT; Schema: integration; Owner: -
--

ALTER TABLE ONLY integration.connections
    ADD CONSTRAINT connections_public_id_key UNIQUE (public_id);


--
-- Name: access_requests access_requests_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.access_requests
    ADD CONSTRAINT access_requests_pkey PRIMARY KEY (id);


--
-- Name: access_requests access_requests_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.access_requests
    ADD CONSTRAINT access_requests_public_id_key UNIQUE (public_id);


--
-- Name: grants grants_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.grants
    ADD CONSTRAINT grants_pkey PRIMARY KEY (id);


--
-- Name: grants grants_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.grants
    ADD CONSTRAINT grants_public_id_key UNIQUE (public_id);


--
-- Name: iam_sessions iam_sessions_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.iam_sessions
    ADD CONSTRAINT iam_sessions_pkey PRIMARY KEY (id);


--
-- Name: iam_sessions iam_sessions_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.iam_sessions
    ADD CONSTRAINT iam_sessions_public_id_key UNIQUE (public_id);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: invitations invitations_public_id_unique; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.invitations
    ADD CONSTRAINT invitations_public_id_unique UNIQUE (public_id);


--
-- Name: org_users org_users_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.org_users
    ADD CONSTRAINT org_users_pkey PRIMARY KEY (id);


--
-- Name: org_users org_users_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.org_users
    ADD CONSTRAINT org_users_public_id_key UNIQUE (public_id);


--
-- Name: organizations orgs_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.organizations
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);


--
-- Name: organizations orgs_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.organizations
    ADD CONSTRAINT orgs_public_id_key UNIQUE (public_id);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (id);


--
-- Name: policies policies_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.policies
    ADD CONSTRAINT policies_public_id_key UNIQUE (public_id);


--
-- Name: principal_role_assignments principal_role_assignments_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principal_role_assignments
    ADD CONSTRAINT principal_role_assignments_pkey PRIMARY KEY (id);


--
-- Name: principal_role_assignments principal_role_assignments_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principal_role_assignments
    ADD CONSTRAINT principal_role_assignments_public_id_key UNIQUE (public_id);


--
-- Name: principals principals_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);


--
-- Name: principals principals_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principals
    ADD CONSTRAINT principals_public_id_key UNIQUE (public_id);


--
-- Name: role_grants role_grants_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.role_grants
    ADD CONSTRAINT role_grants_pkey PRIMARY KEY (id);


--
-- Name: role_grants role_grants_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.role_grants
    ADD CONSTRAINT role_grants_public_id_key UNIQUE (public_id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: roles roles_public_id_key; Type: CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.roles
    ADD CONSTRAINT roles_public_id_key UNIQUE (public_id);


--
-- Name: security_events security_events_pkey; Type: CONSTRAINT; Schema: security; Owner: -
--

ALTER TABLE ONLY security.security_events
    ADD CONSTRAINT security_events_pkey PRIMARY KEY (id);


--
-- Name: playbook_step_assignments playbook_step_assignments_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_step_assignments
    ADD CONSTRAINT playbook_step_assignments_pkey PRIMARY KEY (id);


--
-- Name: playbook_step_assignments playbook_step_assignments_public_id_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_step_assignments
    ADD CONSTRAINT playbook_step_assignments_public_id_key UNIQUE (public_id);


--
-- Name: playbook_steps playbook_steps_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_steps
    ADD CONSTRAINT playbook_steps_pkey PRIMARY KEY (id);


--
-- Name: playbook_steps playbook_steps_public_id_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_steps
    ADD CONSTRAINT playbook_steps_public_id_key UNIQUE (public_id);


--
-- Name: playbook_versions playbook_versions_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_versions
    ADD CONSTRAINT playbook_versions_pkey PRIMARY KEY (id);


--
-- Name: playbook_versions playbook_versions_public_id_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_versions
    ADD CONSTRAINT playbook_versions_public_id_key UNIQUE (public_id);


--
-- Name: playbooks playbooks_pkey; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbooks
    ADD CONSTRAINT playbooks_pkey PRIMARY KEY (id);


--
-- Name: playbooks playbooks_public_id_key; Type: CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbooks
    ADD CONSTRAINT playbooks_public_id_key UNIQUE (public_id);


--
-- Name: folders folders_pkey; Type: CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);


--
-- Name: folders folders_public_id_key; Type: CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.folders
    ADD CONSTRAINT folders_public_id_key UNIQUE (public_id);


--
-- Name: workspace_users workspace_users_pkey; Type: CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.workspace_users
    ADD CONSTRAINT workspace_users_pkey PRIMARY KEY (id);


--
-- Name: workspace_users workspace_users_public_id_key; Type: CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.workspace_users
    ADD CONSTRAINT workspace_users_public_id_key UNIQUE (public_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_public_id_key; Type: CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.workspaces
    ADD CONSTRAINT workspaces_public_id_key UNIQUE (public_id);


--
-- Name: agent_versions_agent_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX agent_versions_agent_idx ON agent.agent_versions USING btree (agent_id);


--
-- Name: agent_versions_agent_latest_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX agent_versions_agent_latest_idx ON agent.agent_versions USING btree (agent_id) WHERE (is_latest = true);


--
-- Name: agent_versions_agent_version_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX agent_versions_agent_version_idx ON agent.agent_versions USING btree (agent_id, version_number);


--
-- Name: agent_versions_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX agent_versions_org_idx ON agent.agent_versions USING btree (org_id, workspace_id);


--
-- Name: agents_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX agents_org_idx ON agent.agents USING btree (org_id, workspace_id);


--
-- Name: agents_org_slug_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX agents_org_slug_idx ON agent.agents USING btree (org_id, slug);


--
-- Name: approval_requests_message_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX approval_requests_message_idx ON agent.approval_requests USING btree (message_id);


--
-- Name: approval_requests_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX approval_requests_org_idx ON agent.approval_requests USING btree (org_id, workspace_id);


--
-- Name: approval_requests_org_resolution_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX approval_requests_org_resolution_idx ON agent.approval_requests USING btree (org_id, workspace_id, resolution);


--
-- Name: background_tasks_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX background_tasks_org_idx ON agent.background_tasks USING btree (org_id, workspace_id);


--
-- Name: background_tasks_org_status_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX background_tasks_org_status_idx ON agent.background_tasks USING btree (org_id, workspace_id, status);


--
-- Name: mcp_servers_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX mcp_servers_org_idx ON agent.mcp_servers USING btree (org_id, workspace_id);


--
-- Name: plan_steps_execution_step_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX plan_steps_execution_step_idx ON agent.plan_steps USING btree (execution_step_id);


--
-- Name: plan_steps_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX plan_steps_org_idx ON agent.plan_steps USING btree (org_id, workspace_id);


--
-- Name: plan_steps_org_status_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX plan_steps_org_status_idx ON agent.plan_steps USING btree (org_id, workspace_id, status);


--
-- Name: skill_versions_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX skill_versions_org_idx ON agent.skill_versions USING btree (org_id, workspace_id);


--
-- Name: skill_versions_skill_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX skill_versions_skill_idx ON agent.skill_versions USING btree (skill_id);


--
-- Name: skill_versions_skill_latest_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX skill_versions_skill_latest_idx ON agent.skill_versions USING btree (skill_id) WHERE (is_latest = true);


--
-- Name: skill_versions_skill_version_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX skill_versions_skill_version_idx ON agent.skill_versions USING btree (skill_id, version_number);


--
-- Name: skills_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX skills_org_idx ON agent.skills USING btree (org_id, workspace_id);


--
-- Name: skills_workspace_slug_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX skills_workspace_slug_idx ON agent.skills USING btree (workspace_id, slug);


--
-- Name: subagent_fanouts_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX subagent_fanouts_org_idx ON agent.subagent_fanouts USING btree (org_id, workspace_id);


--
-- Name: subagent_fanouts_parent_message_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX subagent_fanouts_parent_message_idx ON agent.subagent_fanouts USING btree (parent_message_id);


--
-- Name: subagent_runs_fanout_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX subagent_runs_fanout_idx ON agent.subagent_runs USING btree (fanout_id);


--
-- Name: subagent_runs_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX subagent_runs_org_idx ON agent.subagent_runs USING btree (org_id, workspace_id);


--
-- Name: subagent_runs_status_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX subagent_runs_status_idx ON agent.subagent_runs USING btree (status);


--
-- Name: tool_assignments_agent_version_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX tool_assignments_agent_version_idx ON agent.tool_assignments USING btree (agent_version_id);


--
-- Name: tool_assignments_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX tool_assignments_org_idx ON agent.tool_assignments USING btree (org_id, workspace_id);


--
-- Name: tool_assignments_pair_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX tool_assignments_pair_idx ON agent.tool_assignments USING btree (agent_version_id, tool_version_id);


--
-- Name: tool_assignments_tool_version_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX tool_assignments_tool_version_idx ON agent.tool_assignments USING btree (tool_version_id);


--
-- Name: tool_versions_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX tool_versions_org_idx ON agent.tool_versions USING btree (org_id, workspace_id);


--
-- Name: tool_versions_tool_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX tool_versions_tool_idx ON agent.tool_versions USING btree (tool_id);


--
-- Name: tool_versions_tool_latest_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX tool_versions_tool_latest_idx ON agent.tool_versions USING btree (tool_id) WHERE (is_latest = true);


--
-- Name: tool_versions_tool_version_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX tool_versions_tool_version_idx ON agent.tool_versions USING btree (tool_id, version_number);


--
-- Name: tools_org_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE INDEX tools_org_idx ON agent.tools USING btree (org_id, workspace_id);


--
-- Name: tools_org_slug_idx; Type: INDEX; Schema: agent; Owner: -
--

CREATE UNIQUE INDEX tools_org_slug_idx ON agent.tools USING btree (org_id, slug);


--
-- Name: accounts_provider_account_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX accounts_provider_account_idx ON auth.accounts USING btree (provider_id, account_id);


--
-- Name: accounts_user_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX accounts_user_idx ON auth.accounts USING btree (user_id);


--
-- Name: api_keys_key_prefix_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX api_keys_key_prefix_idx ON auth.api_keys USING btree (key_prefix);


--
-- Name: api_keys_org_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX api_keys_org_idx ON auth.api_keys USING btree (org_id, workspace_id);


--
-- Name: credentials_org_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX credentials_org_idx ON auth.credentials USING btree (org_id, workspace_id);


--
-- Name: credentials_provider_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX credentials_provider_idx ON auth.credentials USING btree (org_id, provider);


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_expires_idx ON auth.sessions USING btree (expires_at);


--
-- Name: sessions_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX sessions_token_idx ON auth.sessions USING btree (token);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_user_idx ON auth.sessions USING btree (user_id);


--
-- Name: user_preferences_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX user_preferences_user_id_idx ON auth.user_preferences USING btree (user_id);


--
-- Name: users_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX users_email_idx ON auth.users USING btree (email);


--
-- Name: users_username_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX users_username_idx ON auth.users USING btree (username);


--
-- Name: verifications_identifier_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX verifications_identifier_idx ON auth.verifications USING btree (identifier);


--
-- Name: billing_disputes_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX billing_disputes_org_idx ON billing.billing_disputes USING btree (org_id, status);


--
-- Name: billing_disputes_stripe_dispute_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX billing_disputes_stripe_dispute_idx ON billing.billing_disputes USING btree (stripe_dispute_id);


--
-- Name: credit_balances_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX credit_balances_org_idx ON billing.credit_balances USING btree (org_id);


--
-- Name: credit_ledger_grant_idempotency_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX credit_ledger_grant_idempotency_idx ON billing.credit_ledger USING btree (org_id, reason, reference_type, reference_id) WHERE ((reference_type IS NOT NULL) AND (reference_id IS NOT NULL));


--
-- Name: credit_ledger_org_created_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX credit_ledger_org_created_idx ON billing.credit_ledger USING btree (org_id, created_at DESC);


--
-- Name: credit_lots_org_expiry_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX credit_lots_org_expiry_idx ON billing.credit_lots USING btree (org_id, expires_at);


--
-- Name: invoice_line_items_invoice_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX invoice_line_items_invoice_idx ON billing.invoice_line_items USING btree (invoice_id);


--
-- Name: invoice_line_items_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX invoice_line_items_org_idx ON billing.invoice_line_items USING btree (org_id);


--
-- Name: invoices_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX invoices_org_idx ON billing.invoices USING btree (org_id, status);


--
-- Name: invoices_stripe_inv_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX invoices_stripe_inv_idx ON billing.invoices USING btree (stripe_invoice_id);


--
-- Name: org_billing_profiles_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX org_billing_profiles_org_idx ON billing.org_billing_profiles USING btree (org_id);


--
-- Name: org_billing_settings_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX org_billing_settings_org_idx ON billing.org_billing_settings USING btree (org_id);


--
-- Name: payment_methods_org_default_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX payment_methods_org_default_idx ON billing.payment_methods USING btree (org_id) WHERE ((is_default = true) AND (deleted_at IS NULL));


--
-- Name: payment_methods_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX payment_methods_org_idx ON billing.payment_methods USING btree (org_id);


--
-- Name: payment_methods_stripe_pm_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX payment_methods_stripe_pm_idx ON billing.payment_methods USING btree (stripe_payment_method_id);


--
-- Name: plans_slug_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX plans_slug_idx ON billing.plans USING btree (slug);


--
-- Name: stripe_event_processing_event_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX stripe_event_processing_event_idx ON billing.stripe_event_processing USING btree (stripe_event_id);


--
-- Name: stripe_events_stripe_event_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX stripe_events_stripe_event_idx ON billing.stripe_events USING btree (stripe_event_id);


--
-- Name: stripe_events_type_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX stripe_events_type_idx ON billing.stripe_events USING btree (event_type);


--
-- Name: subscriptions_org_active_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX subscriptions_org_active_idx ON billing.subscriptions USING btree (org_id) WHERE (status = 'active'::text);


--
-- Name: subscriptions_org_status_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX subscriptions_org_status_idx ON billing.subscriptions USING btree (org_id, status);


--
-- Name: subscriptions_stripe_sub_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX subscriptions_stripe_sub_idx ON billing.subscriptions USING btree (stripe_subscription_id);


--
-- Name: usage_records_org_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE INDEX usage_records_org_idx ON billing.usage_records USING btree (org_id);


--
-- Name: usage_records_sub_metric_period_idx; Type: INDEX; Schema: billing; Owner: -
--

CREATE UNIQUE INDEX usage_records_sub_metric_period_idx ON billing.usage_records USING btree (subscription_id, metric, period_start, period_end);


--
-- Name: conversations_list_idx; Type: INDEX; Schema: chat; Owner: -
--

CREATE INDEX conversations_list_idx ON chat.conversations USING btree (workspace_id, user_id, deleted_at, archived_at, updated_at);


--
-- Name: conversations_org_idx; Type: INDEX; Schema: chat; Owner: -
--

CREATE INDEX conversations_org_idx ON chat.conversations USING btree (org_id, workspace_id);


--
-- Name: conversations_user_idx; Type: INDEX; Schema: chat; Owner: -
--

CREATE INDEX conversations_user_idx ON chat.conversations USING btree (user_id);


--
-- Name: messages_conversation_parent_idx; Type: INDEX; Schema: chat; Owner: -
--

CREATE INDEX messages_conversation_parent_idx ON chat.messages USING btree (conversation_id, parent_message_id);


--
-- Name: messages_org_idx; Type: INDEX; Schema: chat; Owner: -
--

CREATE INDEX messages_org_idx ON chat.messages USING btree (org_id, workspace_id);


--
-- Name: documents_embedding_status_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX documents_embedding_status_idx ON content.documents USING btree (embedding_status);


--
-- Name: documents_file_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX documents_file_idx ON content.documents USING btree (file_id);


--
-- Name: documents_folder_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX documents_folder_idx ON content.documents USING btree (folder_id);


--
-- Name: documents_org_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX documents_org_idx ON content.documents USING btree (org_id, workspace_id);


--
-- Name: files_checksum_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX files_checksum_idx ON content.files USING btree (org_id, checksum_sha256);


--
-- Name: files_org_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX files_org_idx ON content.files USING btree (org_id, workspace_id);


--
-- Name: files_storage_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE UNIQUE INDEX files_storage_idx ON content.files USING btree (storage_provider, storage_bucket, storage_key);


--
-- Name: generated_assets_conversation_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX generated_assets_conversation_idx ON content.generated_assets USING btree (conversation_id);


--
-- Name: generated_assets_org_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX generated_assets_org_idx ON content.generated_assets USING btree (org_id, workspace_id);


--
-- Name: generated_assets_user_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX generated_assets_user_idx ON content.generated_assets USING btree (user_id);


--
-- Name: triggers_event_type_idx; Type: INDEX; Schema: event; Owner: -
--

CREATE INDEX triggers_event_type_idx ON event.triggers USING btree (org_id, event_type);


--
-- Name: triggers_org_idx; Type: INDEX; Schema: event; Owner: -
--

CREATE INDEX triggers_org_idx ON event.triggers USING btree (org_id, workspace_id);


--
-- Name: workflow_triggers_org_idx; Type: INDEX; Schema: event; Owner: -
--

CREATE INDEX workflow_triggers_org_idx ON event.workflow_triggers USING btree (org_id, workspace_id);


--
-- Name: workflow_triggers_pair_idx; Type: INDEX; Schema: event; Owner: -
--

CREATE UNIQUE INDEX workflow_triggers_pair_idx ON event.workflow_triggers USING btree (trigger_id, playbook_version_id);


--
-- Name: workflow_triggers_playbook_version_idx; Type: INDEX; Schema: event; Owner: -
--

CREATE INDEX workflow_triggers_playbook_version_idx ON event.workflow_triggers USING btree (playbook_version_id);


--
-- Name: workflow_triggers_trigger_idx; Type: INDEX; Schema: event; Owner: -
--

CREATE INDEX workflow_triggers_trigger_idx ON event.workflow_triggers USING btree (trigger_id);


--
-- Name: execution_artifacts_document_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_artifacts_document_idx ON execution.execution_artifacts USING btree (document_id);


--
-- Name: execution_artifacts_execution_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_artifacts_execution_idx ON execution.execution_artifacts USING btree (execution_id);


--
-- Name: execution_artifacts_org_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_artifacts_org_idx ON execution.execution_artifacts USING btree (org_id, workspace_id);


--
-- Name: execution_steps_execution_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_steps_execution_idx ON execution.execution_steps USING btree (execution_id);


--
-- Name: execution_steps_org_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_steps_org_idx ON execution.execution_steps USING btree (org_id, workspace_id);


--
-- Name: execution_steps_started_at_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_steps_started_at_idx ON execution.execution_steps USING btree (started_at);


--
-- Name: execution_steps_status_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_steps_status_idx ON execution.execution_steps USING btree (status);


--
-- Name: execution_steps_step_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX execution_steps_step_idx ON execution.execution_steps USING btree (playbook_step_id);


--
-- Name: executions_org_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX executions_org_idx ON execution.executions USING btree (org_id, workspace_id);


--
-- Name: executions_playbook_version_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX executions_playbook_version_idx ON execution.executions USING btree (playbook_version_id);


--
-- Name: executions_started_at_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX executions_started_at_idx ON execution.executions USING btree (started_at);


--
-- Name: executions_status_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX executions_status_idx ON execution.executions USING btree (status);


--
-- Name: executions_triggered_by_message_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX executions_triggered_by_message_idx ON execution.executions USING btree (triggered_by_message_id);


--
-- Name: tool_calls_org_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX tool_calls_org_idx ON execution.tool_calls USING btree (org_id, workspace_id);


--
-- Name: tool_calls_status_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX tool_calls_status_idx ON execution.tool_calls USING btree (status);


--
-- Name: tool_calls_step_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX tool_calls_step_idx ON execution.tool_calls USING btree (execution_step_id);


--
-- Name: tool_calls_tool_version_idx; Type: INDEX; Schema: execution; Owner: -
--

CREATE INDEX tool_calls_tool_version_idx ON execution.tool_calls USING btree (tool_version_id);


--
-- Name: connections_org_idx; Type: INDEX; Schema: integration; Owner: -
--

CREATE INDEX connections_org_idx ON integration.connections USING btree (org_id, workspace_id);


--
-- Name: connections_provider_idx; Type: INDEX; Schema: integration; Owner: -
--

CREATE INDEX connections_provider_idx ON integration.connections USING btree (org_id, provider);


--
-- Name: access_requests_org_status_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX access_requests_org_status_idx ON org.access_requests USING btree (org_id, status);


--
-- Name: access_requests_requester_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX access_requests_requester_idx ON org.access_requests USING btree (requester_id);


--
-- Name: grants_capability_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX grants_capability_idx ON org.grants USING btree (capability_id);


--
-- Name: grants_principal_scope_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX grants_principal_scope_idx ON org.grants USING btree (principal_id, scope_id);


--
-- Name: iam_sessions_org_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX iam_sessions_org_idx ON org.iam_sessions USING btree (org_id);


--
-- Name: iam_sessions_principal_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX iam_sessions_principal_idx ON org.iam_sessions USING btree (principal_id);


--
-- Name: invitations_org_email_pending_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE UNIQUE INDEX invitations_org_email_pending_idx ON org.invitations USING btree (org_id, email) WHERE (status = 'pending'::text);


--
-- Name: invitations_org_status_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX invitations_org_status_idx ON org.invitations USING btree (org_id, status);


--
-- Name: org_users_org_user_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE UNIQUE INDEX org_users_org_user_idx ON org.org_users USING btree (org_id, user_id);


--
-- Name: org_users_user_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX org_users_user_idx ON org.org_users USING btree (user_id);


--
-- Name: organizations_slug_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE UNIQUE INDEX organizations_slug_idx ON org.organizations USING btree (slug);


--
-- Name: organizations_status_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX organizations_status_idx ON org.organizations USING btree (status);


--
-- Name: policies_org_capability_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX policies_org_capability_idx ON org.policies USING btree (org_id, capability_id);


--
-- Name: pra_principal_org_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX pra_principal_org_idx ON org.principal_role_assignments USING btree (principal_id, org_id);


--
-- Name: pra_principal_role_org_null_workspace_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE UNIQUE INDEX pra_principal_role_org_null_workspace_idx ON org.principal_role_assignments USING btree (principal_id, role_id, org_id) WHERE (workspace_id IS NULL);


--
-- Name: pra_principal_role_org_workspace_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE UNIQUE INDEX pra_principal_role_org_workspace_idx ON org.principal_role_assignments USING btree (principal_id, role_id, org_id, workspace_id) WHERE (workspace_id IS NOT NULL);


--
-- Name: pra_role_org_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX pra_role_org_idx ON org.principal_role_assignments USING btree (role_id, org_id);


--
-- Name: pra_workspace_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX pra_workspace_idx ON org.principal_role_assignments USING btree (workspace_id);


--
-- Name: principals_idp_subject_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX principals_idp_subject_idx ON org.principals USING btree (idp_subject);


--
-- Name: principals_org_kind_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX principals_org_kind_idx ON org.principals USING btree (org_id, kind);


--
-- Name: principals_workspace_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX principals_workspace_idx ON org.principals USING btree (workspace_id);


--
-- Name: role_grants_org_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX role_grants_org_idx ON org.role_grants USING btree (org_id);


--
-- Name: role_grants_role_capability_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX role_grants_role_capability_idx ON org.role_grants USING btree (role_id, capability_id);


--
-- Name: roles_org_name_idx; Type: INDEX; Schema: org; Owner: -
--

CREATE INDEX roles_org_name_idx ON org.roles USING btree (org_id, name);


--
-- Name: security_events_org_occurred_idx; Type: INDEX; Schema: security; Owner: -
--

CREATE INDEX security_events_org_occurred_idx ON security.security_events USING btree (org_id, occurred_at);


--
-- Name: security_events_type_occurred_idx; Type: INDEX; Schema: security; Owner: -
--

CREATE INDEX security_events_type_occurred_idx ON security.security_events USING btree (event_type, occurred_at);


--
-- Name: playbook_step_assignments_agent_version_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX playbook_step_assignments_agent_version_idx ON workflow.playbook_step_assignments USING btree (agent_version_id);


--
-- Name: playbook_step_assignments_org_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX playbook_step_assignments_org_idx ON workflow.playbook_step_assignments USING btree (org_id, workspace_id);


--
-- Name: playbook_step_assignments_step_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX playbook_step_assignments_step_idx ON workflow.playbook_step_assignments USING btree (playbook_step_id);


--
-- Name: playbook_steps_version_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX playbook_steps_version_idx ON workflow.playbook_steps USING btree (playbook_version_id);


--
-- Name: playbook_steps_version_key_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE UNIQUE INDEX playbook_steps_version_key_idx ON workflow.playbook_steps USING btree (playbook_version_id, step_key);


--
-- Name: playbook_versions_playbook_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX playbook_versions_playbook_idx ON workflow.playbook_versions USING btree (playbook_id);


--
-- Name: playbook_versions_playbook_latest_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE UNIQUE INDEX playbook_versions_playbook_latest_idx ON workflow.playbook_versions USING btree (playbook_id) WHERE (is_latest = true);


--
-- Name: playbook_versions_playbook_version_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE UNIQUE INDEX playbook_versions_playbook_version_idx ON workflow.playbook_versions USING btree (playbook_id, version_number);


--
-- Name: playbooks_org_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE INDEX playbooks_org_idx ON workflow.playbooks USING btree (org_id, workspace_id);


--
-- Name: playbooks_org_slug_idx; Type: INDEX; Schema: workflow; Owner: -
--

CREATE UNIQUE INDEX playbooks_org_slug_idx ON workflow.playbooks USING btree (org_id, slug);


--
-- Name: folders_org_idx; Type: INDEX; Schema: workspace; Owner: -
--

CREATE INDEX folders_org_idx ON workspace.folders USING btree (org_id, workspace_id);


--
-- Name: folders_path_idx; Type: INDEX; Schema: workspace; Owner: -
--

CREATE INDEX folders_path_idx ON workspace.folders USING gist (path);


--
-- Name: workspace_users_user_idx; Type: INDEX; Schema: workspace; Owner: -
--

CREATE INDEX workspace_users_user_idx ON workspace.workspace_users USING btree (user_id);


--
-- Name: workspace_users_workspace_user_idx; Type: INDEX; Schema: workspace; Owner: -
--

CREATE UNIQUE INDEX workspace_users_workspace_user_idx ON workspace.workspace_users USING btree (workspace_id, user_id);


--
-- Name: workspaces_org_idx; Type: INDEX; Schema: workspace; Owner: -
--

CREATE INDEX workspaces_org_idx ON workspace.workspaces USING btree (org_id);


--
-- Name: workspaces_org_slug_idx; Type: INDEX; Schema: workspace; Owner: -
--

CREATE UNIQUE INDEX workspaces_org_slug_idx ON workspace.workspaces USING btree (org_id, slug);


--
-- Name: agent_versions agent_versions_agent_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.agent_versions
    ADD CONSTRAINT agent_versions_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent.agents(id) ON DELETE CASCADE;


--
-- Name: agent_versions agent_versions_parent_version_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.agent_versions
    ADD CONSTRAINT agent_versions_parent_version_id_fkey FOREIGN KEY (parent_version_id) REFERENCES agent.agent_versions(id);


--
-- Name: skill_versions skill_versions_parent_version_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.skill_versions
    ADD CONSTRAINT skill_versions_parent_version_id_fkey FOREIGN KEY (parent_version_id) REFERENCES agent.skill_versions(id);


--
-- Name: skill_versions skill_versions_skill_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.skill_versions
    ADD CONSTRAINT skill_versions_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES agent.skills(id) ON DELETE CASCADE;


--
-- Name: subagent_runs subagent_runs_fanout_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.subagent_runs
    ADD CONSTRAINT subagent_runs_fanout_id_fkey FOREIGN KEY (fanout_id) REFERENCES agent.subagent_fanouts(id) ON DELETE CASCADE;


--
-- Name: tool_assignments tool_assignments_agent_version_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_assignments
    ADD CONSTRAINT tool_assignments_agent_version_id_fkey FOREIGN KEY (agent_version_id) REFERENCES agent.agent_versions(id) ON DELETE CASCADE;


--
-- Name: tool_assignments tool_assignments_tool_version_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_assignments
    ADD CONSTRAINT tool_assignments_tool_version_id_fkey FOREIGN KEY (tool_version_id) REFERENCES agent.tool_versions(id) ON DELETE CASCADE;


--
-- Name: tool_versions tool_versions_parent_version_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_versions
    ADD CONSTRAINT tool_versions_parent_version_id_fkey FOREIGN KEY (parent_version_id) REFERENCES agent.tool_versions(id);


--
-- Name: tool_versions tool_versions_tool_id_fkey; Type: FK CONSTRAINT; Schema: agent; Owner: -
--

ALTER TABLE ONLY agent.tool_versions
    ADD CONSTRAINT tool_versions_tool_id_fkey FOREIGN KEY (tool_id) REFERENCES agent.tools(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.user_preferences
    ADD CONSTRAINT user_preferences_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: billing_disputes billing_disputes_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.billing_disputes
    ADD CONSTRAINT billing_disputes_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: credit_balances credit_balances_org_id_org_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_balances
    ADD CONSTRAINT credit_balances_org_id_org_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: credit_balances credit_balances_tenant_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_balances
    ADD CONSTRAINT credit_balances_tenant_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: credit_ledger credit_ledger_org_id_org_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_ledger
    ADD CONSTRAINT credit_ledger_org_id_org_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: credit_ledger credit_ledger_tenant_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_ledger
    ADD CONSTRAINT credit_ledger_tenant_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: credit_lots credit_lots_org_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.credit_lots
    ADD CONSTRAINT credit_lots_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: invoice_line_items invoice_line_items_invoice_id_billing_invoices_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice_line_items
    ADD CONSTRAINT invoice_line_items_invoice_id_billing_invoices_id_fk FOREIGN KEY (invoice_id) REFERENCES billing.invoices(id) ON DELETE CASCADE;


--
-- Name: invoice_line_items invoice_line_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoice_line_items
    ADD CONSTRAINT invoice_line_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_org_id_org_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_org_id_org_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: invoices invoices_subscription_id_billing_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_subscription_id_billing_subscriptions_id_fk FOREIGN KEY (subscription_id) REFERENCES billing.subscriptions(id);


--
-- Name: invoices invoices_subscription_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES billing.subscriptions(id);


--
-- Name: invoices invoices_tenant_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_tenant_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: org_billing_profiles org_billing_profiles_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.org_billing_profiles
    ADD CONSTRAINT org_billing_profiles_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE;


--
-- Name: org_billing_settings org_billing_settings_org_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.org_billing_settings
    ADD CONSTRAINT org_billing_settings_org_id_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE;


--
-- Name: payment_methods payment_methods_org_id_org_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.payment_methods
    ADD CONSTRAINT payment_methods_org_id_org_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: payment_methods payment_methods_tenant_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.payment_methods
    ADD CONSTRAINT payment_methods_tenant_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: stripe_event_processing stripe_event_processing_stripe_event_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.stripe_event_processing
    ADD CONSTRAINT stripe_event_processing_stripe_event_id_fkey FOREIGN KEY (stripe_event_id) REFERENCES billing.stripe_events(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_org_id_org_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.subscriptions
    ADD CONSTRAINT subscriptions_org_id_org_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: subscriptions subscriptions_plan_id_billing_plans_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_billing_plans_id_fk FOREIGN KEY (plan_id) REFERENCES billing.plans(id);


--
-- Name: subscriptions subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.subscriptions
    ADD CONSTRAINT subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES billing.plans(id);


--
-- Name: subscriptions subscriptions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: usage_records usage_records_org_id_org_organizations_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.usage_records
    ADD CONSTRAINT usage_records_org_id_org_organizations_id_fk FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: usage_records usage_records_subscription_id_billing_subscriptions_id_fk; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.usage_records
    ADD CONSTRAINT usage_records_subscription_id_billing_subscriptions_id_fk FOREIGN KEY (subscription_id) REFERENCES billing.subscriptions(id);


--
-- Name: usage_records usage_records_subscription_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.usage_records
    ADD CONSTRAINT usage_records_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES billing.subscriptions(id);


--
-- Name: usage_records usage_records_tenant_id_fkey; Type: FK CONSTRAINT; Schema: billing; Owner: -
--

ALTER TABLE ONLY billing.usage_records
    ADD CONSTRAINT usage_records_tenant_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: chat; Owner: -
--

ALTER TABLE ONLY chat.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES chat.conversations(id) ON DELETE CASCADE;


--
-- Name: messages messages_parent_message_id_fkey; Type: FK CONSTRAINT; Schema: chat; Owner: -
--

ALTER TABLE ONLY chat.messages
    ADD CONSTRAINT messages_parent_message_id_fkey FOREIGN KEY (parent_message_id) REFERENCES chat.messages(id);


--
-- Name: documents documents_file_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.documents
    ADD CONSTRAINT documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES content.files(id);


--
-- Name: workflow_triggers workflow_triggers_trigger_id_fkey; Type: FK CONSTRAINT; Schema: event; Owner: -
--

ALTER TABLE ONLY event.workflow_triggers
    ADD CONSTRAINT workflow_triggers_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES event.triggers(id) ON DELETE CASCADE;


--
-- Name: execution_artifacts execution_artifacts_execution_id_fkey; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.execution_artifacts
    ADD CONSTRAINT execution_artifacts_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES execution.executions(id) ON DELETE CASCADE;


--
-- Name: execution_steps execution_steps_execution_id_fkey; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.execution_steps
    ADD CONSTRAINT execution_steps_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES execution.executions(id) ON DELETE CASCADE;


--
-- Name: tool_calls tool_calls_execution_step_id_fkey; Type: FK CONSTRAINT; Schema: execution; Owner: -
--

ALTER TABLE ONLY execution.tool_calls
    ADD CONSTRAINT tool_calls_execution_step_id_fkey FOREIGN KEY (execution_step_id) REFERENCES execution.execution_steps(id) ON DELETE CASCADE;


--
-- Name: access_requests access_requests_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.access_requests
    ADD CONSTRAINT access_requests_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: access_requests access_requests_requester_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.access_requests
    ADD CONSTRAINT access_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES org.principals(id);


--
-- Name: grants grants_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.grants
    ADD CONSTRAINT grants_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: grants grants_principal_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.grants
    ADD CONSTRAINT grants_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES org.principals(id);


--
-- Name: iam_sessions iam_sessions_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.iam_sessions
    ADD CONSTRAINT iam_sessions_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: iam_sessions iam_sessions_principal_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.iam_sessions
    ADD CONSTRAINT iam_sessions_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES org.principals(id);


--
-- Name: policies policies_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.policies
    ADD CONSTRAINT policies_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: principal_role_assignments principal_role_assignments_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principal_role_assignments
    ADD CONSTRAINT principal_role_assignments_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: principal_role_assignments principal_role_assignments_principal_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principal_role_assignments
    ADD CONSTRAINT principal_role_assignments_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES org.principals(id);


--
-- Name: principal_role_assignments principal_role_assignments_role_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principal_role_assignments
    ADD CONSTRAINT principal_role_assignments_role_id_fkey FOREIGN KEY (role_id) REFERENCES org.roles(id);


--
-- Name: principals principals_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.principals
    ADD CONSTRAINT principals_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: role_grants role_grants_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.role_grants
    ADD CONSTRAINT role_grants_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: role_grants role_grants_role_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.role_grants
    ADD CONSTRAINT role_grants_role_id_fkey FOREIGN KEY (role_id) REFERENCES org.roles(id);


--
-- Name: roles roles_org_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.roles
    ADD CONSTRAINT roles_org_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id);


--
-- Name: org_users tenant_users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: org; Owner: -
--

ALTER TABLE ONLY org.org_users
    ADD CONSTRAINT tenant_users_tenant_id_fkey FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE;


--
-- Name: playbook_step_assignments playbook_step_assignments_playbook_step_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_step_assignments
    ADD CONSTRAINT playbook_step_assignments_playbook_step_id_fkey FOREIGN KEY (playbook_step_id) REFERENCES workflow.playbook_steps(id) ON DELETE CASCADE;


--
-- Name: playbook_steps playbook_steps_playbook_version_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_steps
    ADD CONSTRAINT playbook_steps_playbook_version_id_fkey FOREIGN KEY (playbook_version_id) REFERENCES workflow.playbook_versions(id) ON DELETE CASCADE;


--
-- Name: playbook_versions playbook_versions_parent_version_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_versions
    ADD CONSTRAINT playbook_versions_parent_version_id_fkey FOREIGN KEY (parent_version_id) REFERENCES workflow.playbook_versions(id);


--
-- Name: playbook_versions playbook_versions_playbook_id_fkey; Type: FK CONSTRAINT; Schema: workflow; Owner: -
--

ALTER TABLE ONLY workflow.playbook_versions
    ADD CONSTRAINT playbook_versions_playbook_id_fkey FOREIGN KEY (playbook_id) REFERENCES workflow.playbooks(id) ON DELETE CASCADE;


--
-- Name: folders folders_parent_folder_id_fkey; Type: FK CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.folders
    ADD CONSTRAINT folders_parent_folder_id_fkey FOREIGN KEY (parent_folder_id) REFERENCES workspace.folders(id) ON DELETE SET NULL;


--
-- Name: workspace_users workspace_users_workspace_id_fkey; Type: FK CONSTRAINT; Schema: workspace; Owner: -
--

ALTER TABLE ONLY workspace.workspace_users
    ADD CONSTRAINT workspace_users_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


-- GENERATED by tools/scripts/gen-rls-migration.ts — do not edit by hand.
-- Re-generate with: pnpm tsx tools/scripts/gen-rls-migration.ts
-- Tenant + workspace RLS (OXA-1515). Bypass-aware: app.rls_bypass='on' disables
-- filtering during the seeding window (TENANT_RLS_ENFORCEMENT_ENABLED=false).
-- Applied by: pnpm db:migrate (tools/scripts/db-migrate.ts) via public._migrations.
BEGIN;

ALTER TABLE agent.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agents;
CREATE POLICY tenant_isolation ON agent.agents
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_versions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.agent_versions;
CREATE POLICY tenant_isolation ON agent.agent_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.tools FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.tools;
CREATE POLICY tenant_isolation ON agent.tools
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.tool_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.tool_versions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.tool_versions;
CREATE POLICY tenant_isolation ON agent.tool_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.tool_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.tool_assignments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.tool_assignments;
CREATE POLICY tenant_isolation ON agent.tool_assignments
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.skills FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.skills;
CREATE POLICY tenant_isolation ON agent.skills
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.skill_versions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.skill_versions;
CREATE POLICY tenant_isolation ON agent.skill_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.background_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.background_tasks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.background_tasks;
CREATE POLICY tenant_isolation ON agent.background_tasks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.approval_requests FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.approval_requests;
CREATE POLICY tenant_isolation ON agent.approval_requests
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.subagent_fanouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.subagent_fanouts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.subagent_fanouts;
CREATE POLICY tenant_isolation ON agent.subagent_fanouts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.subagent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.subagent_runs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.subagent_runs;
CREATE POLICY tenant_isolation ON agent.subagent_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.plan_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.plan_steps FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.plan_steps;
CREATE POLICY tenant_isolation ON agent.plan_steps
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.mcp_servers FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.mcp_servers;
CREATE POLICY tenant_isolation ON agent.mcp_servers
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE workflow.playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.playbooks FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflow.playbooks;
CREATE POLICY tenant_isolation ON workflow.playbooks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE workflow.playbook_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.playbook_versions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflow.playbook_versions;
CREATE POLICY tenant_isolation ON workflow.playbook_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE workflow.playbook_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.playbook_steps FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflow.playbook_steps;
CREATE POLICY tenant_isolation ON workflow.playbook_steps
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE workflow.playbook_step_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.playbook_step_assignments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflow.playbook_step_assignments;
CREATE POLICY tenant_isolation ON workflow.playbook_step_assignments
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE event.triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE event.triggers FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON event.triggers;
CREATE POLICY tenant_isolation ON event.triggers
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE event.workflow_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE event.workflow_triggers FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON event.workflow_triggers;
CREATE POLICY tenant_isolation ON event.workflow_triggers
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE execution.executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.executions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON execution.executions;
CREATE POLICY tenant_isolation ON execution.executions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE execution.execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.execution_steps FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON execution.execution_steps;
CREATE POLICY tenant_isolation ON execution.execution_steps
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE execution.tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.tool_calls FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON execution.tool_calls;
CREATE POLICY tenant_isolation ON execution.tool_calls
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE execution.execution_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution.execution_artifacts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON execution.execution_artifacts;
CREATE POLICY tenant_isolation ON execution.execution_artifacts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE chat.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.conversations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chat.conversations;
CREATE POLICY tenant_isolation ON chat.conversations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE chat.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON chat.messages;
CREATE POLICY tenant_isolation ON chat.messages
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE content.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.files FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content.files;
CREATE POLICY tenant_isolation ON content.files
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE content.generated_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.generated_assets FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content.generated_assets;
CREATE POLICY tenant_isolation ON content.generated_assets
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE content.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.documents FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON content.documents;
CREATE POLICY tenant_isolation ON content.documents
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE integration.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.connections FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON integration.connections;
CREATE POLICY tenant_isolation ON integration.connections
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE workspace.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.folders FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.folders;
CREATE POLICY tenant_isolation ON workspace.folders
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE workspace.workspace_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.workspace_users FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.workspace_users;
CREATE POLICY tenant_isolation ON workspace.workspace_users
  USING (current_setting('app.rls_bypass', true) = 'on' OR (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE auth.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.credentials FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth.credentials;
CREATE POLICY tenant_isolation ON auth.credentials
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE auth.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.api_keys FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON auth.api_keys;
CREATE POLICY tenant_isolation ON auth.api_keys
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE org.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.principals FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.principals;
CREATE POLICY tenant_isolation ON org.principals
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

ALTER TABLE org.principal_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.principal_role_assignments FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.principal_role_assignments;
CREATE POLICY tenant_isolation ON org.principal_role_assignments
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

ALTER TABLE org.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.roles FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.roles;
CREATE POLICY tenant_isolation ON org.roles
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.role_grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.role_grants;
CREATE POLICY tenant_isolation ON org.role_grants
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.grants;
CREATE POLICY tenant_isolation ON org.grants
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.policies FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.policies;
CREATE POLICY tenant_isolation ON org.policies
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.access_requests FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.access_requests;
CREATE POLICY tenant_isolation ON org.access_requests
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.iam_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.iam_sessions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.iam_sessions;
CREATE POLICY tenant_isolation ON org.iam_sessions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.org_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.org_users FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.org_users;
CREATE POLICY tenant_isolation ON org.org_users
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE org.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.invitations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.invitations;
CREATE POLICY tenant_isolation ON org.invitations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscriptions FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.subscriptions;
CREATE POLICY tenant_isolation ON billing.subscriptions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.payment_methods FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.payment_methods;
CREATE POLICY tenant_isolation ON billing.payment_methods
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.invoices FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.invoices;
CREATE POLICY tenant_isolation ON billing.invoices
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.invoice_line_items FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.invoice_line_items;
CREATE POLICY tenant_isolation ON billing.invoice_line_items
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.usage_records FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.usage_records;
CREATE POLICY tenant_isolation ON billing.usage_records
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.credit_balances FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.credit_balances;
CREATE POLICY tenant_isolation ON billing.credit_balances
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.credit_ledger FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.credit_ledger;
CREATE POLICY tenant_isolation ON billing.credit_ledger
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.credit_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.credit_lots FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.credit_lots;
CREATE POLICY tenant_isolation ON billing.credit_lots
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.org_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.org_billing_profiles FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.org_billing_profiles;
CREATE POLICY tenant_isolation ON billing.org_billing_profiles
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.org_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.org_billing_settings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.org_billing_settings;
CREATE POLICY tenant_isolation ON billing.org_billing_settings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE billing.billing_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.billing_disputes FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.billing_disputes;
CREATE POLICY tenant_isolation ON billing.billing_disputes
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

ALTER TABLE security.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.security_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security.security_events;
CREATE POLICY tenant_isolation ON security.security_events
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

COMMIT;
-- 0002_security_events_partitioning.sql
--
-- SOC2 / retention: Convert security.security_events from a plain heap to a
-- declarative RANGE-partitioned table (monthly, on occurred_at) with a 7-year
-- retention horizon (matching ClickHouse audit_events TTL).
--
-- Pre-launch / no live data: we drop and recreate the table rather than
-- performing an online pg_rewrite — safe per CLAUDE.md operating mode.
--
-- Partitioning notes
-- ------------------
-- • RANGE-partitioned tables require the partition key in every unique
--   constraint and primary key. The PK becomes (id, occurred_at).
-- • Indexes defined on the parent propagate to all partitions automatically.
-- • A DEFAULT partition catches any row whose occurred_at falls outside an
--   explicit range (e.g. back-dated events, future months not yet created).
-- • pg_partman / pg_cron are NOT assumed — the application-level Inngest cron
--   (packages/inngest-functions) handles partition rollover. See
--   security.audit-partition-rollover Inngest function.
-- • Row-level security MUST be re-applied on the recreated parent. 0001_rls_policies
--   enabled + FORCED RLS and installed the `tenant_isolation` policy on the
--   original heap; the DROP TABLE below wipes that, so step 5 reinstalls the
--   identical workspace_nullable policy on the new partitioned parent. RLS on a
--   partitioned parent enforces on every child partition when rows are accessed
--   through the parent (which is the only path row-level code takes — the audit
--   inserter writes via withSystemDb, an explicit, audited bypass that sets
--   app.rls_bypass='on'). Child partitions therefore need no policy of their own.
--   Skipping step 5 would leave security_events as the one tenant table in the
--   schema without RLS — a SOC2 isolation hole the manifest-coverage test catches.
--
-- Retention: partitions whose entire range is older than 7 years from the
-- application cron run date are eligible for DROP. The cron function enforces
-- this; the migration only creates the structure.
--
-- Partition naming convention: security_events_<YYYY>_<MM>
-- (lexicographic, stable, no ambiguity across years).

-- ── 1. Drop the existing heap table ─────────────────────────────────────────
-- The table is append-only audit data (no FK references from other tables).

DROP TABLE IF EXISTS security.security_events;

-- ── 2. Recreate as a range-partitioned table ─────────────────────────────────

CREATE TABLE security.security_events (
    -- PK must include the partition key in a partitioned table.
    -- id stays UUIDv4 (functionally unique); occurred_at is the partition key.
    id            uuid                     NOT NULL DEFAULT public.uuid_generate_v4(),
    occurred_at   timestamp with time zone NOT NULL DEFAULT now(),
    event_type    text                     NOT NULL,
    actor_user_id uuid,
    org_id        uuid                     NOT NULL,
    workspace_id  uuid,
    capability    text,
    outcome       text                     NOT NULL,
    ip            text,
    user_agent    text,
    request_id    text,

    -- Composite PK includes the partition key (required by Postgres).
    CONSTRAINT security_events_pkey PRIMARY KEY (id, occurred_at),

    -- Check constraints mirror the TS union to reject unknown values at the DB layer.
    CONSTRAINT security_events_event_type_check CHECK (event_type IN (
        'auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out',
        'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified',
        'api_key.created', 'api_key.revoked', 'api_key.used',
        'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error',
        'org.member_invited', 'org.member_removed', 'org.role_changed'
    )),

    CONSTRAINT security_events_outcome_check CHECK (outcome IN (
        'allow', 'deny', 'error', 'success'
    ))
)
PARTITION BY RANGE (occurred_at);

-- ── 3. Parent-level indexes (auto-inherited by all partitions) ────────────────

-- Compliance range queries: "show me all events for org X in period Y"
CREATE INDEX security_events_org_occurred_idx
    ON security.security_events (org_id, occurred_at);

-- Alert queries: "show me all denied invocations in the last hour"
CREATE INDEX security_events_type_occurred_idx
    ON security.security_events (event_type, occurred_at);

-- ── 4. Initial monthly partitions ────────────────────────────────────────────
--
-- We create a handful of back-months (in case any back-dated rows arrive),
-- the current month (2026-06), and several future months so inserts never
-- land in DEFAULT unexpectedly during normal operation.
--
-- The Inngest cron extends this window rolling-forward every month.
-- DEFAULT partition is a permanent safety net.

-- Back-months (3 months back from current: 2026-03 through 2026-05)
CREATE TABLE security.security_events_2026_03
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-03-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');

CREATE TABLE security.security_events_2026_04
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-04-01 00:00:00+00') TO ('2026-05-01 00:00:00+00');

CREATE TABLE security.security_events_2026_05
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-05-01 00:00:00+00') TO ('2026-06-01 00:00:00+00');

-- Current month
CREATE TABLE security.security_events_2026_06
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-06-01 00:00:00+00') TO ('2026-07-01 00:00:00+00');

-- 6 months ahead (2026-07 through 2026-12)
CREATE TABLE security.security_events_2026_07
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-07-01 00:00:00+00') TO ('2026-08-01 00:00:00+00');

CREATE TABLE security.security_events_2026_08
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00');

CREATE TABLE security.security_events_2026_09
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-09-01 00:00:00+00') TO ('2026-10-01 00:00:00+00');

CREATE TABLE security.security_events_2026_10
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');

CREATE TABLE security.security_events_2026_11
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00');

CREATE TABLE security.security_events_2026_12
    PARTITION OF security.security_events
    FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00');

-- DEFAULT partition — permanent safety net for any out-of-window rows.
CREATE TABLE security.security_events_default
    PARTITION OF security.security_events DEFAULT;

-- ── 5. Re-apply Row-Level Security on the recreated parent ───────────────────
--
-- The DROP TABLE in step 1 wiped the ENABLE/FORCE RLS + tenant_isolation policy
-- that 0001_rls_policies installed on the original heap. Reinstall the identical
-- workspace_nullable policy on the new partitioned parent so security_events
-- stays tenant-isolated. Enforcement on the parent covers all child partitions
-- when accessed through the parent (the only path row-level code takes); the
-- audit inserter writes via withSystemDb (app.rls_bypass='on'). Child partitions
-- inherit enforcement and need no policy of their own.

ALTER TABLE security.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.security_events FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security.security_events;
CREATE POLICY tenant_isolation ON security.security_events
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));
-- 0003_soc2_auth_hardening.sql
--
-- SOC2 auth hardening — three independent gap-fills:
--
--   (A) rate_limit table for Better Auth database-backed brute-force defense.
--       Stored in the `auth` schema beside the other auth tables.
--       Better Auth resolves the model "rateLimit" → schema key "rateLimit".
--       Fields: id (text PK, BA generates), key (text unique), count (int),
--       lastRequest (bigint ms-since-epoch).
--
--   (B) Postgres trigger on auth.accounts BEFORE INSERT OR UPDATE that nulls
--       each plaintext token column when its *_enc encrypted counterpart is
--       NOT NULL.  Defense-in-depth backstop: Better Auth may bypass the
--       application-layer databaseHook on some write paths; the trigger
--       guarantees the plaintext is never durably stored once encrypted.
--       Safe invariant: we never null a plaintext col when *_enc IS NULL —
--       we would destroy the only copy.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS auth_accounts_strip_plaintext_tokens ON auth.accounts;
--   DROP FUNCTION IF EXISTS auth.strip_plaintext_tokens();
--   DROP TABLE IF EXISTS auth.rate_limit;

-- ── (A) rate_limit table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS auth.rate_limit (
    id           TEXT PRIMARY KEY,
    key          TEXT NOT NULL,
    count        INTEGER NOT NULL DEFAULT 0,
    -- lastRequest stored as bigint (ms since Unix epoch); bigint avoids
    -- timestamp precision/timezone surprises and matches Better Auth's
    -- internal representation (Date.now()).
    "lastRequest" BIGINT NOT NULL DEFAULT 0
);

-- Better Auth looks up records by key on every request; unique ensures
-- exactly one record per (ip, path) pair.
CREATE UNIQUE INDEX IF NOT EXISTS rate_limit_key_idx ON auth.rate_limit (key);

-- ── (B) strip-plaintext-tokens trigger ─────────────────────────────────────

CREATE OR REPLACE FUNCTION auth.strip_plaintext_tokens()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Null each plaintext column only when its encrypted counterpart is
    -- present — so we never destroy the only copy of a token.
    -- Defense-in-depth: the application hook (buildAccountTokenHooks /
    -- buildStripOnlyAccountHooks in packages/auth) already strips on the
    -- covered write paths; this trigger is the backstop for any Better Auth
    -- write path that bypasses the application-layer databaseHook (e.g.
    -- internal account-linking flows, future BA version changes).
    IF NEW.access_token_enc IS NOT NULL THEN
        NEW.access_token := NULL;
    END IF;
    IF NEW.refresh_token_enc IS NOT NULL THEN
        NEW.refresh_token := NULL;
    END IF;
    IF NEW.id_token_enc IS NOT NULL THEN
        NEW.id_token := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_accounts_strip_plaintext_tokens ON auth.accounts;

CREATE TRIGGER auth_accounts_strip_plaintext_tokens
    BEFORE INSERT OR UPDATE ON auth.accounts
    FOR EACH ROW
    EXECUTE FUNCTION auth.strip_plaintext_tokens();
-- Migration: 0004_drop_dead_tables
-- Release-audit Check 4 FAIL remediation: remove 5 tables that have schema
-- definitions, RLS manifest entries, and Drizzle relations but ZERO CRUD
-- reads/writes in any domain route, handler, or seed code. Verified by
-- exhaustive grep across all apps/* and packages/* (excluding test/e2e).
--
-- Dropped tables:
--   agent.tool_assignments        — no domain reads/writes; junction was unused
--   agent.tool_versions           — no domain reads/writes; e2e fixture only
--   workflow.playbook_step_assignments — no domain reads/writes
--   event.workflow_triggers       — no domain reads/writes
--   execution.execution_artifacts — no domain reads/writes
--
-- CASCADE handles any dependent objects (indexes, FK constraints from
-- agent.tool_assignments → agent.tool_versions, etc.).

SET search_path TO public;

-- Drop agent.tool_assignments first (has FK → agent.tool_versions).
DROP TABLE IF EXISTS agent.tool_assignments CASCADE;

-- Drop agent.tool_versions (referenced app-only by execution.tool_calls,
-- which carries no DB-level FK constraint — only an index).
DROP TABLE IF EXISTS agent.tool_versions CASCADE;

-- Drop workflow.playbook_step_assignments.
DROP TABLE IF EXISTS workflow.playbook_step_assignments CASCADE;

-- Drop event.workflow_triggers.
DROP TABLE IF EXISTS event.workflow_triggers CASCADE;

-- Drop execution.execution_artifacts.
DROP TABLE IF EXISTS execution.execution_artifacts CASCADE;
-- 0005_oxagen_app_role.sql
--
-- Non-superuser application role for Row-Level Security enforcement (OXA-1552).
--
-- The tenant-isolation policies in 0001_rls_policies.sql + their FORCE ROW LEVEL
-- SECURITY are only load-bearing when the application connects as a role that
-- does NOT bypass RLS. A superuser — or any role with BYPASSRLS — ignores every
-- policy unconditionally, which is why `assertRlsConnectionSafe()`
-- (packages/database/src/tenant.ts) refuses to boot the app with
-- TENANT_RLS_ENFORCEMENT_ENABLED=true on such a connection.
--
-- This migration provisions `oxagen_app`: NOSUPERUSER, NOBYPASSRLS, with USAGE
-- on every domain schema and full DML on their tables, so it can reach the data
-- but every row is still gated by the policies. It is created NOLOGIN on
-- purpose — the LOGIN password is a secret and must never live in a committed
-- migration. An operator grants LOGIN + a password out-of-band (see
-- tools/scripts/provision-rls-role.ts) and repoints DATABASE_URL at oxagen_app;
-- only then is TENANT_RLS_ENFORCEMENT_ENABLED flipped on. Until that happens the
-- role is inert (cannot connect), so applying this migration is a safe no-op for
-- the running app.
--
-- Idempotent: safe to (re-)run against any environment. Mirrors the tested role
-- setup in packages/database/integration/rls.test.ts.

SET search_path TO public;

-- 1. The role itself — create if absent, and (defensively) strip any elevated
--    attributes if it already exists, so the RLS guarantee can never be silently
--    undermined by a pre-existing role with SUPERUSER/BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    CREATE ROLE oxagen_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

ALTER ROLE oxagen_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- 2. Schema usage + table/sequence DML across all 14 domain schemas. RLS still
--    gates which rows are visible/writable; these grants only make the tables
--    reachable. Run per-schema so a future schema rename surfaces loudly here.
DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'org','auth','workspace','integration','agent','workflow',
    'event','execution','chat','content','graph','evaluation',
    'billing','security'
  ]
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO oxagen_app', s);
    -- Future objects created by the migrating role inherit these grants, so new
    -- tables/sequences don't silently become unreachable for the app role.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app', s);
  END LOOP;
END $$;

-- 3. public: schema usage + EXECUTE on functions (uuid_generate_v7(), citext
--    operators, etc.). Deliberately NO table DML here — the only public table is
--    _migrations, which belongs to the migrate runner, not the app role.
GRANT USAGE ON SCHEMA public TO oxagen_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO oxagen_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO oxagen_app;
-- 0006_oxagen_app_default_privs_for_role.sql
--
-- Forward-fix for 0005_oxagen_app_role.sql (PR review).
--
-- 0005 set `ALTER DEFAULT PRIVILEGES IN SCHEMA … GRANT … TO oxagen_app` without
-- a `FOR ROLE` clause, so the default privileges attach only to objects created
-- by whatever role ran 0005. That role is implicit (the session role), so if a
-- later migration is run by a DIFFERENT database user (CI user rotation, a
-- managed-DB IAM user change), tables it creates would silently NOT be granted
-- to oxagen_app — breaking RLS-enforced reads/writes with no loud error.
--
-- 0005 is immutable (already applied), so we fix forward: re-issue the default
-- privileges with an explicit `FOR ROLE <current migrator>` to make the
-- dependency visible, and re-GRANT on all CURRENT tables/sequences as a belt-and
-- -suspenders resync. ALTER DEFAULT PRIVILEGES and GRANT are idempotent, so this
-- is safe to (re-)run. NOTE: default privileges are inherently per-creating-role
-- in Postgres — full robustness against role rotation means re-running this
-- resync (or `provision-rls-role.ts`) after any migrator-role change; this
-- migration pins the dependency for the role in effect when it is applied.

SET search_path TO public;

DO $$
DECLARE
  s text;
  migrator text := current_user;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'org','auth','workspace','integration','agent','workflow',
    'event','execution','chat','content','graph','evaluation',
    'billing','security'
  ]
  LOOP
    -- Resync grants on existing objects (idempotent).
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO oxagen_app', s);
    -- Explicit FOR ROLE so the dependency on the migrating role is visible.
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app', migrator, s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app', migrator, s);
  END LOOP;

  -- public: function EXECUTE default, FOR ROLE pinned.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO oxagen_app', migrator);
END $$;
-- 0007_billing_security_event_types.sql
--
-- SOC2 CC6.3/CC6.8: Add billing.* event types to the security_events
-- event_type CHECK constraint so that the DB layer rejects unknown values
-- even if application code drifts.
--
-- Background
-- ----------
-- The CHECK constraint was created in 0002_security_events_partitioning.sql.
-- Postgres does not support ALTER TABLE ... ALTER CONSTRAINT, so the only
-- path is DROP + ADD. The parent table is RANGE-partitioned; Postgres
-- propagates CHECK constraints to all child partitions, so the DROP/ADD on
-- the parent is sufficient — no per-partition DDL is required.
--
-- Idempotency
-- -----------
-- DROP CONSTRAINT IF EXISTS is safe to re-run. The ADD CONSTRAINT is also
-- safe because IF NOT EXISTS is not needed here — the DROP ensures it is
-- gone before we add it back. Re-running this migration on a DB where it has
-- already been applied will succeed (the constraint will simply be absent
-- after the DROP and re-created by the ADD).
--
-- Value list
-- ----------
-- The full set of accepted event_type values, kept in lexicographic order
-- within each group, mirrors the SECURITY_EVENT_TYPES array in
-- packages/database/src/schema/security.ts and
-- packages/telemetry/src/security.ts. Any drift between those three sources
-- (TS, migration SQL, running DB) is a SOC2 finding.
--
-- Groups (in order):
--   auth.*           — Auth lifecycle
--   api_key.*        — API key lifecycle
--   billing.*        — Billing mutations (NEW in this migration)
--   capability.*     — Capability authz
--   org.*            — Org management

ALTER TABLE security.security_events
  DROP CONSTRAINT IF EXISTS security_events_event_type_check;

ALTER TABLE security.security_events
  ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN (
    -- Auth lifecycle
    'auth.sign_in',
    'auth.sign_in_failed',
    'auth.sign_out',
    'auth.token_refreshed',
    'auth.password_changed',
    'auth.email_verified',
    -- API key lifecycle
    'api_key.created',
    'api_key.revoked',
    'api_key.used',
    -- Billing mutations
    'billing.access_denied',
    'billing.auto_reload_updated',
    'billing.credits_purchased',
    'billing.payment_method_added',
    'billing.payment_method_default_changed',
    'billing.payment_method_removed',
    'billing.plan_changed',
    'billing.seats_changed',
    'billing.subscription_canceled',
    'billing.subscription_reactivated',
    -- Capability authz
    'capability.invoke_allowed',
    'capability.invoke_denied',
    'capability.invoke_error',
    -- Admin / org management
    'org.member_invited',
    'org.member_removed',
    'org.role_changed'
  ));
-- 0008_installable_plugins.sql
-- Installable plugins foundation: registries, catalog, org governance,
-- workspace install link, encrypted credentials, notifications.
-- Forward migration (immutable after merge). See spec
-- docs/superpowers/specs/2026-06-06-installable-plugins-mcp-design.md §4.

CREATE SCHEMA IF NOT EXISTS mcp;
CREATE SCHEMA IF NOT EXISTS plugin;
CREATE SCHEMA IF NOT EXISTS notification;

-- ---------------------------------------------------------------------------
-- mcp.registries
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.registries (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid,
  name               text NOT NULL,
  base_url           text NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  is_default_seed    boolean NOT NULL DEFAULT false,
  last_synced_at     timestamptz,
  last_synced_cursor text
);
CREATE INDEX registries_org_idx ON mcp.registries (org_id);
CREATE UNIQUE INDEX registries_org_baseurl_uniq
  ON mcp.registries (COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid), base_url);

-- ---------------------------------------------------------------------------
-- mcp.catalog_servers
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.catalog_servers (
  id                  uuid PRIMARY KEY DEFAULT COALESCE(
                        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                        uuid_generate_v4()),
  public_id           citext NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  uuid,
  updated_by_user_id  uuid,
  registry_id         uuid NOT NULL REFERENCES mcp.registries(id) ON DELETE CASCADE,
  name                text NOT NULL,
  version             text NOT NULL,
  is_latest           boolean NOT NULL DEFAULT false,
  title               text,
  description         text NOT NULL,
  repository          jsonb,
  website_url         text,
  icons               jsonb NOT NULL DEFAULT '[]'::jsonb,
  packages            jsonb NOT NULL DEFAULT '[]'::jsonb,
  remotes             jsonb NOT NULL DEFAULT '[]'::jsonb,
  transport_types     text[] NOT NULL DEFAULT '{}'::text[],
  auth_kind           text NOT NULL,
  categories          text[] NOT NULL DEFAULT '{}'::text[],
  readme_html         text,
  readme_fetched_at   timestamptz,
  status              text NOT NULL,
  published_at        timestamptz,
  upstream_updated_at timestamptz,
  status_changed_at   timestamptz,
  meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT catalog_servers_status_check CHECK (status IN ('active','deprecated','deleted')),
  CONSTRAINT catalog_servers_auth_kind_check CHECK (auth_kind IN ('oauth','secret','none'))
);
CREATE UNIQUE INDEX catalog_servers_name_version_uniq ON mcp.catalog_servers (registry_id, name, version);
CREATE INDEX catalog_servers_registry_name_idx ON mcp.catalog_servers (registry_id, name);
CREATE INDEX catalog_servers_categories_gin ON mcp.catalog_servers USING gin (categories);
CREATE INDEX catalog_servers_transport_gin ON mcp.catalog_servers USING gin (transport_types);

-- ---------------------------------------------------------------------------
-- plugin.org_listings
-- ---------------------------------------------------------------------------
CREATE TABLE plugin.org_listings (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  org_id             uuid NOT NULL,
  plugin_type        text NOT NULL,
  catalog_server_id  uuid REFERENCES mcp.catalog_servers(id) ON DELETE SET NULL,
  source             text NOT NULL,
  name               text NOT NULL,
  title              text,
  description        text,
  icon_url           text,
  endpoint_url       text,
  transport          text,
  auth_kind          text NOT NULL,
  auth_config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled            boolean NOT NULL DEFAULT false,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT org_listings_type_check CHECK (plugin_type IN ('mcp_server','integration','content_tool')),
  CONSTRAINT org_listings_source_check CHECK (source IN ('registry','custom')),
  CONSTRAINT org_listings_auth_kind_check CHECK (auth_kind IN ('oauth','secret','none'))
);
CREATE UNIQUE INDEX org_listings_org_type_name_uniq ON plugin.org_listings (org_id, plugin_type, name);
CREATE INDEX org_listings_org_type_idx ON plugin.org_listings (org_id, plugin_type);

-- ---------------------------------------------------------------------------
-- plugin.org_denylist
-- ---------------------------------------------------------------------------
CREATE TABLE plugin.org_denylist (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  plugin_type        text NOT NULL,
  server_name        text NOT NULL,
  reason             text,
  CONSTRAINT org_denylist_type_check CHECK (plugin_type IN ('mcp_server','integration','content_tool'))
);
CREATE UNIQUE INDEX org_denylist_org_type_name_uniq ON plugin.org_denylist (org_id, plugin_type, server_name);

-- ---------------------------------------------------------------------------
-- mcp.credentials  (SOC2 encrypted)
-- ---------------------------------------------------------------------------
CREATE TABLE mcp.credentials (
  id                      uuid PRIMARY KEY DEFAULT COALESCE(
                            CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                              THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                            uuid_generate_v4()),
  public_id               citext NOT NULL UNIQUE,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by_user_id      uuid,
  updated_by_user_id      uuid,
  org_id                  uuid NOT NULL,
  workspace_id            uuid NOT NULL,
  org_listing_id          uuid NOT NULL REFERENCES plugin.org_listings(id) ON DELETE CASCADE,
  auth_kind               text NOT NULL,
  access_token_enc        bytea,
  refresh_token_enc       bytea,
  secret_enc              bytea,
  oauth_client_secret_enc bytea,
  token_kms_key_id        text,
  oauth_client_id         text,
  scopes                  text[] NOT NULL DEFAULT '{}'::text[],
  expires_at              timestamptz,
  status                  text NOT NULL DEFAULT 'active',
  last_refreshed_at       timestamptz,
  CONSTRAINT credentials_auth_kind_check CHECK (auth_kind IN ('oauth','secret')),
  CONSTRAINT credentials_status_check CHECK (status IN ('active','needs_reauth','revoked'))
);
CREATE UNIQUE INDEX credentials_workspace_listing_uniq ON mcp.credentials (workspace_id, org_listing_id);
CREATE INDEX credentials_org_idx ON mcp.credentials (org_id);

-- ---------------------------------------------------------------------------
-- agent.mcp_servers — add org_listing_id link
-- ---------------------------------------------------------------------------
ALTER TABLE agent.mcp_servers ADD COLUMN org_listing_id uuid REFERENCES plugin.org_listings(id) ON DELETE CASCADE;
CREATE INDEX mcp_servers_org_listing_idx ON agent.mcp_servers (org_listing_id);

-- ---------------------------------------------------------------------------
-- notification.notifications
-- ---------------------------------------------------------------------------
CREATE TABLE notification.notifications (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  workspace_id       uuid,
  user_id            uuid NOT NULL,
  kind               text NOT NULL,
  title              text NOT NULL,
  body               text,
  deep_link          text,
  unread             boolean NOT NULL DEFAULT true,
  archived           boolean NOT NULL DEFAULT false,
  emailed_at         timestamptz,
  CONSTRAINT notifications_kind_check CHECK (kind IN ('system','approval','run','member','security'))
);
CREATE INDEX notifications_user_unread_idx ON notification.notifications (user_id, unread) WHERE archived = false;
CREATE INDEX notifications_org_idx ON notification.notifications (org_id);

-- ---------------------------------------------------------------------------
-- Seed: the official public MCP registry, enabled by default for every org
-- (org_id NULL ⇒ global default seed).
-- ---------------------------------------------------------------------------
INSERT INTO mcp.registries (public_id, org_id, name, base_url, enabled, is_default_seed)
VALUES (
  'mreg_officialmcpregistryseed',
  NULL,
  'Official MCP Registry',
  'https://registry.modelcontextprotocol.io',
  true,
  true
)
ON CONFLICT (public_id) DO NOTHING;
-- 0009_mcp_server_enabled.sql — workspace enable/disable toggle for installed MCP servers.
ALTER TABLE agent.mcp_servers ADD COLUMN enabled boolean NOT NULL DEFAULT true;
CREATE INDEX mcp_servers_enabled_idx ON agent.mcp_servers (workspace_id, enabled);
CREATE UNIQUE INDEX mcp_servers_ws_listing_uniq ON agent.mcp_servers (workspace_id, org_listing_id) WHERE org_listing_id IS NOT NULL;
-- 0010_plugin_mcp_notification_rls.sql
--
-- Tenant RLS + app-role grants for the installable-plugins epic (OXA-1515 / SOC2 CC6.3).
--
-- Migration 0008 created three new Postgres schemas (mcp, plugin, notification)
-- and six tables AFTER the 0001 baseline + the 0005 oxagen_app role grants. Two
-- gaps resulted, both closed here:
--
--   1. DATA ISOLATION: plugin.org_listings, plugin.org_denylist, mcp.credentials
--      (encrypted OAuth tokens!), mcp.registries, and notification.notifications
--      are all tenant-scoped but shipped with NO row-level security — only
--      app-layer eq(org_id) filters guarded them. Any unfiltered query or direct
--      DB path leaked across tenants. We ENABLE + FORCE RLS and add bypass-aware
--      tenant_isolation policies matching the POLICY_MANIFEST policyClass.
--
--   2. REACHABILITY: the 0005 grant loop enumerates 14 schemas and omitted these
--      three. Under TENANT_RLS_ENFORCEMENT_ENABLED=true the non-superuser
--      oxagen_app role could not USAGE/DML them, risking permission-denied in
--      prod. We grant USAGE + table/sequence DML + default privileges, exactly
--      mirroring 0005 (RLS still gates which rows are visible).
--
-- Policy classes (see packages/database/src/tenant-policy.manifest.ts):
--   plugin.org_listings           org_only          (org_id NOT NULL)
--   plugin.org_denylist           org_only          (org_id NOT NULL)
--   mcp.credentials               standard          (org_id + workspace_id NOT NULL)
--   notification.notifications    workspace_nullable (org_id NOT NULL, workspace_id nullable)
--   mcp.registries                org_or_global     (org_id NULLABLE: NULL = global seed)
--   mcp.catalog_servers           — no org_id, shared catalog, intentionally unscoped
--
-- Idempotent: ENABLE/FORCE are no-ops if already set; DROP POLICY IF EXISTS +
-- CREATE makes policy creation re-runnable; grants are additive. The oxagen_app
-- role is guaranteed to exist (created unconditionally by 0005, which runs first).
-- Applied by: pnpm db:migrate via public._migrations.

SET search_path TO public;

BEGIN;

-- 1. oxagen_app schema usage + table/sequence DML on the three new schemas.
DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['mcp', 'plugin', 'notification']
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO oxagen_app', s);
    -- Future objects created by the migrating role inherit these grants.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app', s);
  END LOOP;
END $$;

-- 2. Tenant-isolation RLS policies (bypass-aware: app.rls_bypass='on' disables
--    filtering during seeding / withSystemDb paths, exactly like 0001).

-- plugin.org_listings — org_only
ALTER TABLE plugin.org_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.org_listings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON plugin.org_listings;
CREATE POLICY tenant_isolation ON plugin.org_listings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- plugin.org_denylist — org_only
ALTER TABLE plugin.org_denylist ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.org_denylist FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON plugin.org_denylist;
CREATE POLICY tenant_isolation ON plugin.org_denylist
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- mcp.credentials — standard (org_id + workspace_id)
ALTER TABLE mcp.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.credentials FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.credentials;
CREATE POLICY tenant_isolation ON mcp.credentials
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- mcp.registries — org_or_global (NULL org_id = global default seed visible to all)
ALTER TABLE mcp.registries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.registries FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.registries;
CREATE POLICY tenant_isolation ON mcp.registries
  -- READS: own-org rows + the global (NULL org_id) default-seed catalog.
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id IS NULL OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  -- WRITES: own-org rows ONLY. Inserting/updating a global (NULL) registry is
  -- reserved for the seeding/system path (app.rls_bypass='on') — without this a
  -- tenant could publish a platform-wide malicious MCP endpoint (SSRF / supply chain).
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- notification.notifications — workspace_nullable (org_id NOT NULL, workspace_id nullable)
ALTER TABLE notification.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notifications FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification.notifications;
CREATE POLICY tenant_isolation ON notification.notifications
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

COMMIT;
-- 0011_mcp_registries_write_scope.sql
--
-- Tighten the mcp.registries RLS policy to asymmetric read/write (OXA-1515 / SOC2 CC6.3).
--
-- 0010 gave mcp.registries an org_or_global policy where USING == WITH CHECK:
-- both reads AND writes allowed `org_id IS NULL OR org_id = current_org`. That read
-- rule is correct (every tenant must see the global, NULL-org default-seed registry
-- plus its own rows), but the SAME rule on WITH CHECK is a privilege-escalation hole:
-- a tenant could INSERT/UPDATE a row with org_id = NULL and thereby publish a
-- PLATFORM-WIDE MCP registry endpoint visible to every other tenant — an SSRF /
-- supply-chain vector (everyone would resolve plugins from the attacker's registry).
--
-- This migration recreates the policy with split predicates:
--   • READS  (USING):     global (NULL) rows + own-org rows.   [unchanged]
--   • WRITES (WITH CHECK): own-org rows ONLY. Creating/altering a global (NULL)
--     registry is reserved for the seeding/system path (app.rls_bypass='on').
--
-- 0010 is immutable (already applied to preview); this is the forward migration
-- that supersedes its mcp.registries policy. Matches the org_or_global predicates
-- emitted by tools/scripts/gen-rls-migration.ts. Idempotent: DROP POLICY IF EXISTS
-- + CREATE. Applied by pnpm db:migrate via public._migrations.

SET search_path TO public;

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON mcp.registries;
CREATE POLICY tenant_isolation ON mcp.registries
  -- READS: own-org rows + the global (NULL org_id) default-seed catalog.
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id IS NULL OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  -- WRITES: own-org rows ONLY. Publishing a global (NULL) registry is reserved for
  -- the seeding/system path (app.rls_bypass='on') to prevent a tenant from shipping
  -- a platform-wide malicious MCP endpoint (SSRF / supply chain).
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
-- RLS for workspace.workspaces (OXA-1515 follow-up).
-- The table has org_id NOT NULL but no workspace_id, so it uses the org_only
-- policy class — same pattern as billing.subscriptions, org.org_users, etc.

ALTER TABLE workspace.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.workspaces FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.workspaces;
CREATE POLICY tenant_isolation ON workspace.workspaces
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));
-- 0013_generated_assets_document_kinds.sql
-- Extend the generated_assets kind CHECK to allow document file types.
-- Forward migration (immutable after apply). See OXA-1650.

ALTER TABLE content.generated_assets
  DROP CONSTRAINT IF EXISTS generated_assets_kind_check;

ALTER TABLE content.generated_assets
  ADD CONSTRAINT generated_assets_kind_check
    CHECK (kind IN ('image', 'video', 'document', 'spreadsheet', 'presentation', 'pdf', 'archive'));
-- 0014_workflow_runs.sql
--
-- Create the agent.workflow_runs + agent.workflow_run_tasks tables backing the
-- multi-agent workflow capability (workflow.run / workflow.status / workflow.cancel).
-- These tables are declared in packages/database/src/schema/workflow-runs.ts and
-- are referenced by 0016_workflow_run_rls_policies.sql; this migration is their
-- system of record. Mirrors the id/audit/org-scope mixins and matches the
-- table-creation style of 0008_installable_plugins.sql.
--
-- Forward migration — immutable after merge (OXA-1515 policy).

-- ── agent.workflow_runs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent.workflow_runs (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  title              text        NOT NULL,
  goal               text        NOT NULL,
  status             citext      NOT NULL DEFAULT 'planning',
  plan_json          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  total_tasks        integer     NOT NULL DEFAULT 0,
  completed_tasks    integer     NOT NULL DEFAULT 0,
  failed_tasks       integer     NOT NULL DEFAULT 0,
  max_parallelism    integer     NOT NULL DEFAULT 50,
  output_format      citext      NOT NULL DEFAULT 'json',
  result_url         text,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT workflow_runs_status_check
    CHECK (status IN ('planning', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT workflow_runs_output_format_check
    CHECK (output_format IN ('json', 'csv'))
);

CREATE INDEX IF NOT EXISTS workflow_runs_org_status_idx
  ON agent.workflow_runs (org_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS workflow_runs_org_idx
  ON agent.workflow_runs (org_id, workspace_id);

-- ── agent.workflow_run_tasks ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent.workflow_run_tasks (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  workflow_run_id    uuid        NOT NULL,
  task_index         integer     NOT NULL,
  title              text        NOT NULL,
  goal               text        NOT NULL,
  status             citext      NOT NULL DEFAULT 'pending',
  inngest_run_id     text,
  output_json        jsonb,
  error              text,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT workflow_run_tasks_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS workflow_run_tasks_run_idx
  ON agent.workflow_run_tasks (workflow_run_id);
CREATE INDEX IF NOT EXISTS workflow_run_tasks_org_status_idx
  ON agent.workflow_run_tasks (org_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS workflow_run_tasks_org_idx
  ON agent.workflow_run_tasks (org_id, workspace_id);

-- ── Enable RLS (policies added in 0016) ──────────────────────────────────────
ALTER TABLE agent.workflow_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.workflow_run_tasks ENABLE ROW LEVEL SECURITY;

-- ── oxagen_app grants ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.workflow_runs      TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.workflow_run_tasks TO oxagen_app;
  END IF;
END;
$$;
-- 0015_security_policy_and_event_types.sql
--
-- 1. Add security.org_security_policy — org-level MFA enforcement config (CC6.1/CC6.2).
-- 2. Widen security_events.event_type CHECK constraint to include the four new kinds:
--      security.mfa_policy_updated, security.session_revoked,
--      access.review_completed, access.member_access_confirmed
-- 3. Grant the oxagen_app role SELECT/INSERT/UPDATE on the new table.
--
-- Forward migration — immutable after merge (OXA-1515 policy).

-- ── 1. org_security_policy ──────────────────────────────────────────────────

CREATE TABLE security.org_security_policy (
  org_id              uuid        PRIMARY KEY NOT NULL,
  mfa_required        boolean     NOT NULL DEFAULT false,
  mfa_grace_hours     integer     NOT NULL DEFAULT 48,
  updated_by_user_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX org_security_policy_org_idx ON security.org_security_policy (org_id);

-- ── 2. Widen the event_type CHECK on security_events ────────────────────────
-- The partitioned parent table holds the CHECK; we drop the old one and
-- add the new wider constraint. Postgres allows ALTER TABLE on the parent of a
-- declarative-partitioned table; the constraint propagates to existing child
-- partitions automatically.

ALTER TABLE security.security_events
  DROP CONSTRAINT IF EXISTS security_events_event_type_check;

ALTER TABLE security.security_events
  ADD CONSTRAINT security_events_event_type_check
  CHECK (event_type IN (
    'auth.sign_in',
    'auth.sign_in_failed',
    'auth.sign_out',
    'auth.token_refreshed',
    'auth.password_changed',
    'auth.email_verified',
    'api_key.created',
    'api_key.revoked',
    'api_key.used',
    'billing.access_denied',
    'billing.auto_reload_updated',
    'billing.credits_purchased',
    'billing.payment_method_added',
    'billing.payment_method_default_changed',
    'billing.payment_method_removed',
    'billing.plan_changed',
    'billing.seats_changed',
    'billing.subscription_canceled',
    'billing.subscription_reactivated',
    'capability.invoke_allowed',
    'capability.invoke_denied',
    'capability.invoke_error',
    'org.member_invited',
    'org.member_removed',
    'org.role_changed',
    'security.mfa_policy_updated',
    'security.session_revoked',
    'access.review_completed',
    'access.member_access_confirmed'
  ));

-- ── 3. oxagen_app grants ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON security.org_security_policy TO oxagen_app;
  END IF;
END;
$$;
-- Add RLS policies for workflow_run tables (OXA-1515)
-- These tables exist in the schema but lacked the standard bypass-aware RLS policies.
BEGIN;

-- Update agent.workflow_runs with standard RLS policy
ALTER TABLE agent.workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_runs_org_isolation ON agent.workflow_runs;
DROP POLICY IF EXISTS tenant_isolation ON agent.workflow_runs;
CREATE POLICY tenant_isolation ON agent.workflow_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- Update agent.workflow_run_tasks with standard RLS policy
ALTER TABLE agent.workflow_run_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_run_tasks_org_isolation ON agent.workflow_run_tasks;
DROP POLICY IF EXISTS tenant_isolation ON agent.workflow_run_tasks;
CREATE POLICY tenant_isolation ON agent.workflow_run_tasks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

COMMIT;
-- Add RLS policy for org_security_policy table (OXA-1515)
BEGIN;

ALTER TABLE security.org_security_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security.org_security_policy;
CREATE POLICY tenant_isolation ON security.org_security_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
-- Enable RLS on security.org_security_policy (OXA-1515 compliance fix)
-- Migration 0017 issued FORCE ROW LEVEL SECURITY but omitted ENABLE, causing
-- the policy to be defined but never evaluated. This forward migration applies
-- the missing ENABLE directive so the tenant_isolation policy is enforced.

BEGIN;

ALTER TABLE security.org_security_policy ENABLE ROW LEVEL SECURITY;

COMMIT;
-- Create agent execution tables with correct RLS (OXA-1515)
-- Migration 0014 was in src/migrations/ (never executed by db-migrate) with broken
-- RLS predicates (iam.org_members doesn't exist; auth.uid() is Supabase-specific).
-- This migration creates the tables in drizzle/ with the standard bypass-aware RLS.

BEGIN;

-- agent.agent_executions: canonical execution record
CREATE TABLE agent.agent_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_version_id uuid NOT NULL,

  -- Polymorphic origin: exactly one non-null enforced by CHECK
  origin_type text NOT NULL,
  origin_id uuid NOT NULL,

  -- Execution state
  status citext NOT NULL DEFAULT 'planning',
  input_payload jsonb NOT NULL,
  output_payload jsonb,
  failure_reason text,

  -- Telemetry (canonical for metering)
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  latency_ms bigint,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_usd numeric(10, 6),

  -- Sync flag for Neo4j mirror
  synced_to_graph_at timestamp with time zone,

  -- Audit
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,

  CONSTRAINT agent_executions_status_check
    CHECK (status IN ('planning', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_executions_origin_type_check
    CHECK (origin_type IN ('chat', 'event_trigger', 'scheduled_job', 'mcp_request', 'workflow_run')),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_executions_org_idx ON agent.agent_executions(org_id, workspace_id);
CREATE INDEX agent_executions_origin_idx ON agent.agent_executions(origin_type, origin_id);
CREATE INDEX agent_executions_status_idx ON agent.agent_executions(status);
CREATE INDEX agent_executions_agent_idx ON agent.agent_executions(agent_id);
CREATE INDEX agent_executions_created_at_idx ON agent.agent_executions(created_at DESC);

ALTER TABLE agent.agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_executions_tenant_isolation ON agent.agent_executions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- agent.agent_execution_steps: step-level detail
CREATE TABLE agent.agent_execution_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES agent.agent_executions(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,

  step_number integer NOT NULL,
  step_type text NOT NULL,
  status citext NOT NULL,

  input_payload jsonb NOT NULL,
  output_payload jsonb,
  failure_reason text,

  latency_ms bigint,
  input_tokens integer,
  output_tokens integer,

  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,

  CONSTRAINT agent_execution_steps_step_type_check
    CHECK (step_type IN ('tool_call', 'decision', 'retry', 'wait')),
  CONSTRAINT agent_execution_steps_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_execution_steps_unique_per_execution
    UNIQUE (execution_id, step_number),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_execution_steps_execution_idx ON agent.agent_execution_steps(execution_id);
CREATE INDEX agent_execution_steps_org_idx ON agent.agent_execution_steps(org_id, workspace_id);

ALTER TABLE agent.agent_execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_execution_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_execution_steps_tenant_isolation ON agent.agent_execution_steps
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- agent.agent_tool_calls: tool invocation detail
CREATE TABLE agent.agent_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_step_id uuid NOT NULL REFERENCES agent.agent_execution_steps(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  workspace_id uuid NOT NULL,

  tool_name text NOT NULL,
  tool_type text NOT NULL,

  request_payload jsonb NOT NULL,
  response_payload jsonb,
  status text NOT NULL,

  latency_ms bigint,
  input_tokens integer,
  output_tokens integer,

  created_at timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT agent_tool_calls_tool_type_check
    CHECK (tool_type IN ('mcp', 'capability', 'builtin')),
  CONSTRAINT agent_tool_calls_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_tool_calls_step_idx ON agent.agent_tool_calls(execution_step_id);
CREATE INDEX agent_tool_calls_tool_idx ON agent.agent_tool_calls(tool_name);
CREATE INDEX agent_tool_calls_org_idx ON agent.agent_tool_calls(org_id, workspace_id);

ALTER TABLE agent.agent_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_tool_calls_tenant_isolation ON agent.agent_tool_calls
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
-- 0020: Drop orphan agent execution tables created in 0019 but never wired to domain code.
-- Migration 0019 created agent_executions, agent_execution_steps, and agent_tool_calls
-- with full RLS + relations, but zero references exist in any handler, service, or query path.
-- Inngest supervisor and execution orchestration were never implemented.
-- Dropping the orphan schema to satisfy "no dead code, no dead tables" requirement.

DROP TABLE agent.agent_tool_calls CASCADE;
DROP TABLE agent.agent_execution_steps CASCADE;
DROP TABLE agent.agent_executions CASCADE;
-- Drop remaining orphan tables that were created but never wired to any handler or route.
-- These were identified during schema audit (Phase 4 check 4 in release-audit).
-- Tables: content.documents, agent.tools, workflow.playbooks, event.triggers,
-- integration.connections, and the entire execution schema with its tables.
--
-- Migration 0015 in src/migrations/ was intended to drop these but src/migrations/
-- is unreachable by db-migrate (which only reads from drizzle/). This migration
-- completes that cleanup atomically.

DROP TABLE IF EXISTS execution.execution_artifacts CASCADE;
DROP TABLE IF EXISTS execution.tool_calls CASCADE;
DROP TABLE IF EXISTS execution.execution_steps CASCADE;
DROP TABLE IF EXISTS execution.executions CASCADE;
DROP SCHEMA IF EXISTS execution CASCADE;

DROP TABLE IF EXISTS integration.connections CASCADE;
DROP SCHEMA IF EXISTS integration CASCADE;

DROP TABLE IF EXISTS event.workflow_triggers CASCADE;
DROP TABLE IF EXISTS event.triggers CASCADE;
DROP SCHEMA IF EXISTS event CASCADE;

DROP TABLE IF EXISTS workflow.playbook_step_assignments CASCADE;
DROP TABLE IF EXISTS workflow.playbook_steps CASCADE;
DROP TABLE IF EXISTS workflow.playbook_versions CASCADE;
DROP TABLE IF EXISTS workflow.playbooks CASCADE;
DROP SCHEMA IF EXISTS workflow CASCADE;

DROP TABLE IF EXISTS agent.tools CASCADE;
DROP TABLE IF EXISTS agent.tool_versions CASCADE;
DROP TABLE IF EXISTS agent.tool_assignments CASCADE;

DROP TABLE IF EXISTS content.documents CASCADE;
-- Drop content.files table: never written to, always returns 404 from file.serve.
-- This table was created in baseline but asset.upload never inserts reference rows,
-- making it permanently unreachable. Dropping as dead schema.

DROP POLICY IF EXISTS "content_files_tenant_rls" ON "content"."files";
DROP TABLE IF EXISTS "content"."files" CASCADE;
-- 0023: Update credit_ledger reason check constraint to include all valid reasons
-- The original constraint was missing grant_plan_upgrade, grant_credit_pack,
-- grant_auto_reload, and clawback_dispute, causing silent insert failures.
-- These must match CREDIT_REASONS constant in packages/billing/src/constants.ts

ALTER TABLE billing.credit_ledger
DROP CONSTRAINT credit_ledger_reason_check,
ADD CONSTRAINT credit_ledger_reason_check CHECK (
  reason = ANY (ARRAY[
    'grant_signup'::text,
    'grant_plan_renewal'::text,
    'grant_plan_upgrade'::text,
    'grant_credit_pack'::text,
    'grant_auto_reload'::text,
    'grant_manual'::text,
    'consume_execution'::text,
    'consume_tool_call'::text,
    'consume_token_overage'::text,
    'refund'::text,
    'clawback_dispute'::text,
    'adjustment'::text
  ])
);
-- Drop orphaned schema tables: agent.agents, agent.agent_versions, workspace.folders, org.iam_sessions
-- These tables have schema definitions but zero CRUD references in the codebase.
-- Per oxagen-engineering-policy §3: "dead code and dead schema are FAIL."
-- All RLS policies are removed alongside table drops.

DROP TABLE IF EXISTS agent.agent_versions CASCADE;
DROP TABLE IF EXISTS agent.agents CASCADE;
DROP TABLE IF EXISTS workspace.folders CASCADE;
DROP TABLE IF EXISTS org.iam_sessions CASCADE;
-- Drop orphaned agent_version_id column from chat.conversations.
-- The referenced agent.agent_versions table was dropped in 0024; this column
-- became a dangling dead reference with no corresponding Drizzle definition.

ALTER TABLE chat.conversations DROP COLUMN IF EXISTS agent_version_id;
-- Drop orphan agent.plan_steps table.
-- This table has migrations, RLS policies, and Drizzle relations but zero
-- INSERT callers in the codebase. Only UPDATE is referenced (agent.plan.approve)
-- but can never match existing rows since none are ever created.

DROP TABLE IF EXISTS "agent"."plan_steps" CASCADE;
-- Drop org.grants and org.policies tables (dead schema: zero write paths, read-only stubs)
DROP TABLE IF EXISTS org.policies CASCADE;
DROP TABLE IF EXISTS org.grants CASCADE;

-- Drop unused schema files from codebase
-- execution.ts, integration.ts, workflow-runs.ts, event.ts are comment-only stubs retained for historical reference
-- and will be deleted from packages/database/src/schema/ in the code commit
-- 0030_ensure_content_workflow_schemas.sql
--
-- Forward migration — idempotent guard for content and workflow schemas.
--
-- 0028 created content.documents/forms and workflow.automations/automation_runs,
-- assuming the baseline's schema creation had already run. On DBs predating the
-- baseline's workflow-schema creation (where workflow tables historically lived
-- in the agent schema), 0028 failed with 'schema workflow does not exist'.
--
-- This migration adds idempotent CREATE SCHEMA IF NOT EXISTS so the tables are
-- self-sufficient on any DB state — forward migrations that depend on them no
-- longer need to be edited to re-introduce schema creation.
--
BEGIN;

CREATE SCHEMA IF NOT EXISTS content;
CREATE SCHEMA IF NOT EXISTS workflow;

COMMIT;
-- 0028_documents_forms_automations_prefs.sql
--
-- Program 0 — make the contract-declared stub capabilities real. Creates the
-- backing tables for document.*, form.*, and automation.* (previously stubs
-- returning fake data), and adds the agent.skills.enabled column that
-- skill.workspace.list needs.
--
-- Tables declared in packages/database/src/schema/{content,workflow}.ts. RLS
-- policies use the standard bypass-aware tenant_isolation form (mirrors 0016);
-- POLICY_MANIFEST entries added in the same change (tenant-policy.manifest.ts).
-- Mirrors the id/audit/org-scope mixin column style of 0014_workflow_runs.sql.
--
-- Forward migration — immutable after merge (OXA-1515 policy).
BEGIN;

-- ── content.documents ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content.documents (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  title              text        NOT NULL,
  content            text        NOT NULL DEFAULT '',
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS documents_org_idx ON content.documents (org_id, workspace_id);

-- ── content.forms ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content.forms (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  title              text        NOT NULL,
  fields             jsonb       NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS forms_org_idx ON content.forms (org_id, workspace_id);

-- ── content.form_submissions ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content.form_submissions (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  form_id            uuid        NOT NULL,
  responses          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status             citext      NOT NULL DEFAULT 'submitted',
  CONSTRAINT form_submissions_status_check
    CHECK (status IN ('submitted', 'reviewed', 'archived'))
);
CREATE INDEX IF NOT EXISTS form_submissions_form_idx ON content.form_submissions (form_id);
CREATE INDEX IF NOT EXISTS form_submissions_org_idx ON content.form_submissions (org_id, workspace_id);

-- ── workflow.automations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow.automations (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  deleted_at         timestamptz,
  deleted_by_user_id uuid,
  name               text        NOT NULL,
  status             citext      NOT NULL DEFAULT 'active',
  trigger_config     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  action_config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT automations_status_check
    CHECK (status IN ('active', 'paused', 'archived'))
);
CREATE INDEX IF NOT EXISTS automations_org_idx ON workflow.automations (org_id, workspace_id);

-- ── workflow.automation_runs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow.automation_runs (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  automation_id      uuid        NOT NULL,
  status             citext      NOT NULL DEFAULT 'running',
  payload            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT automation_runs_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS automation_runs_automation_idx ON workflow.automation_runs (automation_id);
CREATE INDEX IF NOT EXISTS automation_runs_org_status_idx ON workflow.automation_runs (org_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS automation_runs_org_idx ON workflow.automation_runs (org_id, workspace_id);

-- ── Row-level security: standard bypass-aware tenant isolation (mirrors 0016) ──
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'content.documents', 'content.forms', 'content.form_submissions',
    'workflow.automations', 'workflow.automation_runs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
    EXECUTE format($pol$
      CREATE POLICY tenant_isolation ON %s
        USING (current_setting('app.rls_bypass', true) = 'on'
          OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
              AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
        WITH CHECK (current_setting('app.rls_bypass', true) = 'on'
          OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
              AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
    $pol$, t);
  END LOOP;

  -- oxagen_app grants (non-superuser app role; only when provisioned).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON content.documents        TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON content.forms            TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON content.form_submissions TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON workflow.automations     TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON workflow.automation_runs TO oxagen_app;
  END IF;
END;
$$;

-- ── agent.skills: per-workspace enable toggle for skill.workspace.list ─────────
ALTER TABLE agent.skills
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

COMMIT;
-- 0029_agent_execution_tables.sql
--
-- Restore agent execution tracking tables after orphan drop (0020).
-- Tables now have real handlers (recordExecution, agent.sync-execution-to-graph)
-- and are wired into chat.message.execution and conversation event flows.
--
-- Tables declared in packages/database/src/schema/agent.ts. RLS policies use the
-- standard bypass-aware tenant_isolation form (mirrors 0016); POLICY_MANIFEST
-- entries added in the same change (tenant-policy.manifest.ts).
-- Mirrors the id/audit/org-scope mixin column style of 0014_workflow_runs.sql.
--
-- Forward migration — immutable after merge (OXA-1515 policy).
BEGIN;

-- Ensure the target schema exists (idempotent). The baseline creates them on a
-- fresh DB; this guard makes the migration self-sufficient on any DB state.
CREATE SCHEMA IF NOT EXISTS agent;

-- ── agent.agent_executions ───────────────────────────────────────────────────
CREATE TABLE agent.agent_executions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid,
  updated_by_user_id   uuid,
  org_id               uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  agent_id             uuid        NOT NULL,
  agent_version_id     uuid        NOT NULL,
  origin_type          citext      NOT NULL,
  origin_id            uuid        NOT NULL,
  status               citext      NOT NULL DEFAULT 'planning',
  input_payload        jsonb       NOT NULL,
  output_payload       jsonb,
  failure_reason       text,
  started_at           timestamptz,
  completed_at         timestamptz,
  latency_ms           bigint,
  input_tokens         integer,
  output_tokens        integer,
  estimated_cost_usd   numeric(10, 6),
  synced_to_graph_at   timestamptz,

  CONSTRAINT agent_executions_status_check
    CHECK (status IN ('planning', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_executions_origin_type_check
    CHECK (origin_type IN ('chat', 'event_trigger', 'scheduled_job', 'mcp_request', 'workflow_run')),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_executions_org_status_idx
  ON agent.agent_executions(org_id, workspace_id, status);
CREATE INDEX agent_executions_origin_idx
  ON agent.agent_executions(origin_type, origin_id);
CREATE INDEX agent_executions_agent_idx
  ON agent.agent_executions(agent_id);
CREATE INDEX agent_executions_created_at_idx
  ON agent.agent_executions(created_at);

ALTER TABLE agent.agent_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_executions_tenant_isolation ON agent.agent_executions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- ── agent.agent_execution_steps ───────────────────────────────────────────────
CREATE TABLE agent.agent_execution_steps (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid,
  updated_by_user_id   uuid,
  execution_id         uuid        NOT NULL REFERENCES agent.agent_executions(id) ON DELETE CASCADE,
  org_id               uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  step_number          integer     NOT NULL,
  step_type            citext      NOT NULL,
  status               citext      NOT NULL,
  input_payload        jsonb       NOT NULL,
  output_payload       jsonb,
  failure_reason       text,
  latency_ms           bigint,
  input_tokens         integer,
  output_tokens        integer,

  CONSTRAINT agent_execution_steps_step_type_check
    CHECK (step_type IN ('tool_call', 'decision', 'retry', 'wait')),
  CONSTRAINT agent_execution_steps_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_execution_steps_execution_idx
  ON agent.agent_execution_steps(execution_id);
CREATE INDEX agent_execution_steps_org_idx
  ON agent.agent_execution_steps(org_id, workspace_id);

ALTER TABLE agent.agent_execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_execution_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_execution_steps_tenant_isolation ON agent.agent_execution_steps
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- ── agent.agent_tool_calls ───────────────────────────────────────────────────
CREATE TABLE agent.agent_tool_calls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by_user_id   uuid,
  updated_by_user_id   uuid,
  execution_step_id    uuid        NOT NULL REFERENCES agent.agent_execution_steps(id) ON DELETE CASCADE,
  org_id               uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  tool_name            text        NOT NULL,
  tool_type            text        NOT NULL,
  request_payload      jsonb       NOT NULL,
  response_payload     jsonb,
  status               text        NOT NULL,
  latency_ms           bigint,
  input_tokens         integer,
  output_tokens        integer,

  CONSTRAINT agent_tool_calls_tool_type_check
    CHECK (tool_type IN ('mcp', 'capability', 'builtin')),
  CONSTRAINT agent_tool_calls_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  FOREIGN KEY (org_id) REFERENCES org.organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES workspace.workspaces(id) ON DELETE CASCADE
);

CREATE INDEX agent_tool_calls_step_idx
  ON agent.agent_tool_calls(execution_step_id);
CREATE INDEX agent_tool_calls_org_idx
  ON agent.agent_tool_calls(org_id, workspace_id);

ALTER TABLE agent.agent_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agent_tool_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_tool_calls_tenant_isolation ON agent.agent_tool_calls
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
