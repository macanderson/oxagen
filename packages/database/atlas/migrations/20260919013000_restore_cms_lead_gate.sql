-- Restore the cms schema that ADR-043 dropped with the agent runtime.
--
-- The marketing site still posts leads and redeems book codes at /v1/cms/*.
-- Those routes are marketing infrastructure, not agent runtime, and were
-- collateral damage of the excision. Recreate the schema to match the current
-- Drizzle definition (ADR-077 attribution columns, message on leads).

CREATE SCHEMA IF NOT EXISTS "cms";

CREATE TYPE "cms"."company_size" AS ENUM (
	'1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'
);
CREATE TYPE "cms"."referral_source" AS ENUM (
	'search_engine', 'social_media', 'referral', 'email', 'blog_or_content',
	'event_or_conference', 'advertisement', 'word_of_mouth', 'other'
);

CREATE TABLE "cms"."leads" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"public_id" citext NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"email" citext NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"job_title" text,
	"company" text,
	"company_size" "cms"."company_size",
	"mobile_phone" text,
	"country" text,
	"state" text,
	"city" text,
	"address_1" text,
	"address_2" text,
	"referral_source" "cms"."referral_source",
	"tracking_code" text,
	"source" text,
	"page_path" text,
	"message" text,
	"marketing_consent" boolean DEFAULT true NOT NULL,
	CONSTRAINT "leads_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "leads_email_unique" UNIQUE("email")
);
CREATE INDEX "cms_leads_tracking_code_idx" ON "cms"."leads" USING btree ("tracking_code");
CREATE INDEX "cms_leads_created_at_idx" ON "cms"."leads" USING btree ("created_at");

CREATE TABLE "cms"."book_editions" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"public_id" citext NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"slug" citext NOT NULL,
	"book_slug" text NOT NULL,
	"format" text NOT NULL,
	"title" text NOT NULL,
	"html" text NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	CONSTRAINT "book_editions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "book_editions_slug_unique" UNIQUE("slug"),
	CONSTRAINT "cms_book_editions_format_chk" CHECK ("format" IN ('linear','page-flip'))
);
CREATE INDEX "cms_book_editions_book_idx" ON "cms"."book_editions" USING btree ("book_slug");

CREATE TABLE "cms"."book_access_codes" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"public_id" citext NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"code" citext NOT NULL,
	"lead_id" uuid NOT NULL,
	"book_slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"issue_reason" text NOT NULL,
	"parent_code_id" uuid,
	"last_edition_slug" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"ip" text,
	"user_agent" text,
	CONSTRAINT "book_access_codes_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "book_access_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "cms_book_access_codes_status_chk" CHECK ("status" IN ('active','consumed','revoked')),
	CONSTRAINT "cms_book_access_codes_reason_chk" CHECK ("issue_reason" IN ('signup','resend','rotation'))
);
CREATE INDEX "cms_book_access_codes_lead_idx" ON "cms"."book_access_codes" USING btree ("lead_id");
CREATE INDEX "cms_book_access_codes_status_idx" ON "cms"."book_access_codes" USING btree ("status");

ALTER TABLE cms.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms.leads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON cms.leads;
CREATE POLICY system_only ON cms.leads
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE cms.book_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms.book_editions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON cms.book_editions;
CREATE POLICY system_only ON cms.book_editions
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

ALTER TABLE cms.book_access_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms.book_access_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON cms.book_access_codes;
CREATE POLICY system_only ON cms.book_access_codes
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA cms TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON cms.leads TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON cms.book_editions TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON cms.book_access_codes TO oxagen_app;
  END IF;
END
$$;
