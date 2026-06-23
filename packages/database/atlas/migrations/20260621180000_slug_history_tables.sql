-- OXA-1779: slug-rename history + redirect resolution (spec §4.5, §6.1, §6.3).
--
-- Renaming an org or workspace slug breaks every existing bookmark/share link
-- that pinned the old URL. These two tables capture the (old → new) edges, so
-- the resolver can 301/308-redirect requests for an old slug to the canonical
-- current URL. Capture is atomic: the write paths insert one row in the SAME
-- withTenantDb transaction as the slug UPDATE itself. redirect_enabled=false
-- freezes a row so the old URL 404s again (used when a slug is intentionally
-- recycled).
--
-- Resolver lookup runs unscoped (it must precede the tenant scope it produces),
-- so reads go through withSystemDb (RLS bypass). Writes happen inside the
-- existing tenant scope, satisfying the standard / org_only WITH CHECK
-- predicates added below.

-- ── Create "org_slug_history" table ──────────────────────────────────────────
CREATE TABLE "org"."org_slug_history" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "org_id" uuid NOT NULL,
  "old_slug" public.citext NOT NULL,
  "new_slug" public.citext NOT NULL,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  "redirect_enabled" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "org_slug_history_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "org_slug_history_org_id_fk" FOREIGN KEY ("org_id")
    REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Resolver hot path: lookup by old_slug. Org slugs are globally unique so a
-- non-unique index suffices — duplicate old_slug rows can arise when a slug is
-- recycled across orgs (handler picks the most recent by changed_at).
CREATE INDEX "org_slug_history_old_slug_idx" ON "org"."org_slug_history" ("old_slug");
CREATE INDEX "org_slug_history_org_idx" ON "org"."org_slug_history" ("org_id", "changed_at");

-- ── Create "workspace_slug_history" table ───────────────────────────────────
CREATE TABLE "workspace"."workspace_slug_history" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "old_slug" public.citext NOT NULL,
  "new_slug" public.citext NOT NULL,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  "redirect_enabled" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "workspace_slug_history_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "workspace_slug_history_workspace_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "workspace"."workspaces" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
-- Workspace slugs are unique per org (workspaces_org_slug_idx) — the resolver
-- always filters on (org_id, old_slug), so the composite index serves it.
CREATE INDEX "workspace_slug_history_old_slug_idx" ON "workspace"."workspace_slug_history" ("org_id", "old_slug");
CREATE INDEX "workspace_slug_history_workspace_idx" ON "workspace"."workspace_slug_history" ("workspace_id", "changed_at");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS policies for the new tenant-owned tables. drizzle-kit export emits ONLY
-- the Drizzle schema, so tenant_isolation policies are appended here by hand —
-- the same pattern as 20260619152223_external_mcp_consents_and_tool_snapshots
-- and 20260612140000_restore_rls_policies.sql.
-- ────────────────────────────────────────────────────────────────────────────

-- org.org_slug_history → org_only (org_id NN, no workspace_id).
ALTER TABLE org.org_slug_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.org_slug_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.org_slug_history;
CREATE POLICY tenant_isolation ON org.org_slug_history
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- workspace.workspace_slug_history → standard (org_id + workspace_id NN).
ALTER TABLE workspace.workspace_slug_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.workspace_slug_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.workspace_slug_history;
CREATE POLICY tenant_isolation ON workspace.workspace_slug_history
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants. The Atlas baseline regrant
-- (20260612052000_regrant_oxagen_app.sql) installs ALTER DEFAULT PRIVILEGES per
-- schema, so a fresh-environment replay already covers objects created later.
-- These explicit GRANTs are belt-and-suspenders for existing environments where
-- the new tables are created after the default-privilege ALTER ran. Role guard
-- mirrors the regrant migration — fresh CI/preview clusters may not have
-- provisioned oxagen_app yet.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON org.org_slug_history TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.workspace_slug_history TO oxagen_app;
  END IF;
END
$$;
