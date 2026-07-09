-- ingestion.github_installations — platform registry of GitHub App installations.
--
-- ONE row per GitHub account (org/user) the Oxagen GitHub App is installed on.
-- A GitHub App installation is a SINGLETON per GitHub account: installation_id
-- is globally unique and belongs to the GitHub account, not to whichever Oxagen
-- tenant first connected it. Many tenants/workspaces attach to the SAME
-- installation (the App webhook fans out cross-tenant), so this is a shared /
-- system catalog — NOT tenant-scoped, NO RLS — mirroring
-- ingestion.connector_schemas. It is the source of truth for installation
-- identity + lifecycle (suspend/uninstall), replacing the fragile
-- delivery_config ->> 'installationId' JSONB scans and letting a second tenant
-- attach to an already-installed org without re-installing.

-- ── Create "github_installations" table ──────────────────────────────────────
CREATE TABLE "ingestion"."github_installations" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
        CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
          THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
        uuid_generate_v4()) NOT NULL,
	"public_id" citext NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text,
	"account_id" text,
	"account_type" text,
	"app_slug" text,
	"repository_selection" text,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "github_installations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "github_installations_installation_id_uq" UNIQUE("installation_id")
);
CREATE INDEX "github_installations_account_login_idx"
  ON "ingestion"."github_installations" USING btree ("account_login");

-- ────────────────────────────────────────────────────────────────────────────
-- Shared/system catalog — NO tenant RLS (mirrors ingestion.connector_schemas,
-- which is likewise absent from the tenant-policy manifest: no org_id column).
-- oxagen_app least-privilege grants (guarded — fresh clusters may lack the role).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion.github_installations TO oxagen_app;
  END IF;
END
$$;
