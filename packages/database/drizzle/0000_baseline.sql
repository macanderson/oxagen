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

CREATE SCHEMA agent;


--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: billing; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA billing;


--
-- Name: chat; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA chat;


--
-- Name: content; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA content;


--
-- Name: evaluation; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA evaluation;


--
-- Name: event; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA event;


--
-- Name: execution; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA execution;


--
-- Name: graph; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graph;


--
-- Name: integration; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA integration;


--
-- Name: org; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA org;


--
-- Name: security; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA security;


--
-- Name: workflow; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA workflow;


--
-- Name: workspace; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA workspace;


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


