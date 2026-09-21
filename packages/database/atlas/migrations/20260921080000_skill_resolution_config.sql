-- ADR-090: immutable skill configuration snapshots and resolution decisions.
CREATE SCHEMA IF NOT EXISTS skills;

CREATE TABLE "skills"."config_versions" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"version_label" text NOT NULL,
	"repository_binding_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"pull_request_number" integer,
	"enabled" boolean DEFAULT false NOT NULL,
	"config_digest" text NOT NULL,
	"sources" jsonb NOT NULL,
	"search" jsonb NOT NULL,
	"unbound_repo" jsonb NOT NULL,
	"reflection" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "config_versions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "skill_config_versions_digest_check" CHECK ("skills"."config_versions"."config_digest" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "skill_config_versions_commit_check" CHECK ("skills"."config_versions"."commit_sha" ~ '^[a-f0-9]{40,64}$'),
	CONSTRAINT "skill_config_versions_pr_check" CHECK ("skills"."config_versions"."pull_request_number" IS NULL OR "skills"."config_versions"."pull_request_number" > 0)
);

CREATE TABLE "skills"."resolutions" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"config_version_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version" text NOT NULL,
	"skill_digest" text NOT NULL,
	"source" text NOT NULL,
	"decision" text NOT NULL,
	"withheld_reason" text,
	"loaded" boolean DEFAULT false NOT NULL,
	"token_cost" integer NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resolutions_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "skill_resolutions_decision_check" CHECK ("skills"."resolutions"."decision" IN ('allowed', 'needs_approval', 'denied')),
	CONSTRAINT "skill_resolutions_withheld_check" CHECK ("skills"."resolutions"."withheld_reason" IS NULL OR ("skills"."resolutions"."withheld_reason" IN ('out_of_scope', 'unapproved_digest') AND "skills"."resolutions"."decision" = 'denied' AND NOT "skills"."resolutions"."loaded" AND "skills"."resolutions"."token_cost" = 0)),
	CONSTRAINT "skill_resolutions_load_check" CHECK (NOT "skills"."resolutions"."loaded" OR "skills"."resolutions"."decision" = 'allowed'),
	CONSTRAINT "skill_resolutions_cost_check" CHECK ("skills"."resolutions"."token_cost" >= 0),
	CONSTRAINT "skill_resolutions_digest_check" CHECK ("skills"."resolutions"."skill_digest" ~ '^sha256:[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX "skill_config_versions_label_uq" ON "skills"."config_versions" USING btree ("org_id","workspace_id","version_label");
CREATE UNIQUE INDEX "skill_config_versions_commit_uq" ON "skills"."config_versions" USING btree ("org_id","workspace_id","repository_binding_id","commit_sha");
CREATE UNIQUE INDEX "skill_config_versions_scoped_id_uq" ON "skills"."config_versions" USING btree ("org_id","workspace_id","id");
CREATE INDEX "skill_config_versions_published_idx" ON "skills"."config_versions" USING btree ("org_id","workspace_id","published_at");
CREATE INDEX "skill_resolutions_run_idx" ON "skills"."resolutions" USING btree ("org_id","workspace_id","run_id","resolved_at");
ALTER TABLE "skills"."resolutions" ADD CONSTRAINT "skill_resolutions_config_fk" FOREIGN KEY ("org_id","workspace_id","config_version_id") REFERENCES "skills"."config_versions"("org_id","workspace_id","id") ON DELETE no action ON UPDATE no action;

ALTER TABLE skills.config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills.config_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON skills.config_versions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND
    workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND
    workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE skills.resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills.resolutions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON skills.resolutions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND
    workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (
    org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND
    workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA skills TO oxagen_app;
    GRANT SELECT, INSERT ON skills.config_versions, skills.resolutions TO oxagen_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON skills.config_versions, skills.resolutions FROM oxagen_app;
  END IF;
END $$;
