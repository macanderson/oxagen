-- The onboarding gate and the single-use enrollment token (#2967; MC spec
-- App. F, §7.2; mockup OB_STEPS / REG_TOKEN).
--
-- Hand-assembled from packages/database/src/schema/{org,tacho,agent}.ts in the
-- style of the tacho control-plane migration (atlas migrate diff is broken by
-- the pg_trgm fresh-replay defect). Plain DDL only; no cross-schema FK
-- (app-enforced per CLAUDE.md). RLS for the two new tables is generated from
-- the tenant policy manifest into 20260915202100_rls_onboarding_tables.sql.
--
--   1. org.onboarding_state: one row per organization. create_org writes it
--      at step 'wrap' with a 14-day provisional window; advance_onboarding
--      moves it between 'wrap' and 'run'; the first frame ingest_tacho_events
--      accepts from one of the organization's hosts is the only writer of
--      'unlocked', first_frame_at and first_run_id; bind_main_repository sets
--      main_repo_bound_at. Organizations that predate the gate get no row:
--      they were never provisional and no first frame is known for them, so
--      a missing row reads as unlocked with no window (get_onboarding_state),
--      has no gate to move (advance_onboarding), and passes the provisional
--      check that publish_context_record runs.
--   2. tacho.enrollment_tokens: the one-time token create_enrollment_token
--      mints for a registered agent and enroll_host consumes once.
--   3. agent.agents.registered_via: 'ui' | 'cli' | 'onboarding'. The agent
--      whose first frame opened the gate is stamped 'onboarding' by the ingest.

-- ── 1. org.onboarding_state ─────────────────────────────────────────────────
CREATE TABLE "org"."onboarding_state" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"step" text DEFAULT 'wrap' NOT NULL,
	"first_frame_at" timestamp with time zone,
	"first_run_id" text,
	"provisional_until" timestamp with time zone NOT NULL,
	"main_repo_bound_at" timestamp with time zone,
	"detected_repository" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_state_step_check" CHECK ("step" IN ('wrap', 'run', 'unlocked')),
	CONSTRAINT "onboarding_state_first_frame_check" CHECK (("step" = 'unlocked') = ("first_frame_at" IS NOT NULL) AND ("first_frame_at" IS NULL) = ("first_run_id" IS NULL))
);

-- ── 2. tacho.enrollment_tokens ──────────────────────────────────────────────
CREATE TABLE "tacho"."enrollment_tokens" (
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
	"agent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_to_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_host_id" uuid,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "enrollment_tokens_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tacho_enrollment_tokens_hash_check" CHECK ("token_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "tacho_enrollment_tokens_used_check" CHECK (("used_at" IS NULL) = ("used_by_host_id" IS NULL))
);
CREATE UNIQUE INDEX "tacho_enrollment_tokens_hash_uniq" ON "tacho"."enrollment_tokens" USING btree ("token_hash");
CREATE INDEX "tacho_enrollment_tokens_agent_idx" ON "tacho"."enrollment_tokens" USING btree ("org_id","workspace_id","agent_id");

-- ── 3. agent.agents.registered_via ──────────────────────────────────────────
ALTER TABLE "agent"."agents"
  ADD COLUMN "registered_via" text DEFAULT 'ui' NOT NULL,
  ADD CONSTRAINT "agents_registered_via_check" CHECK ("registered_via" IN ('ui', 'cli', 'onboarding'));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON org.onboarding_state TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.enrollment_tokens TO oxagen_app';
  END IF;
END
$$;
