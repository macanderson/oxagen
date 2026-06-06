-- 0010_security_events_partitioning.sql
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
-- • Row-level security is intentionally NOT enabled on this table here. The
--   baseline ships zero RLS, and the audit inserter (makeSecurityEventInserter
--   over a raw db() connection) sets no tenant GUC and no rls_bypass. Enabling
--   FORCE RLS on this one table in isolation — with a policy keyed on
--   app.current_org_id / app.rls_bypass that nothing sets — would reject every
--   audit INSERT in prod (a superuser dev connection masks it locally) and
--   silently empty the audit trail. RLS is a holistic rollout tracked under
--   OXA-1515 (build @oxagen/tenancy + withTenantDb + GUC plumbing, migrate all
--   db() callsites, then ENABLE/FORCE across all tenant tables at once). This
--   migration only changes the table's physical layout, not its access model.
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
