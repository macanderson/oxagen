-- Namespace identity — immutable, globally-unique agent keys
-- (`org_namespace.workspace_namespace.agent_slug`).
--
-- A namespace is a short, human-readable, IMMUTABLE handle (like a Linear team
-- key). It is deliberately SEPARATE from the org/workspace slug: slugs are
-- renameable (org_slug_history / workspace_slug_history capture the trail),
-- whereas a namespace is chosen once and never changes so it can anchor a stable
-- global identity. The 32-char agentKey budget is 6 (org) + 1 + 6 (workspace) +
-- 1 + 18 (agent slug).
--
-- This migration:
--   1. Adds organizations.namespace  (citext, ^[a-z0-9]{2,6}$, globally unique).
--   2. Adds workspaces.namespace     (citext, ^[a-z0-9]{2,6}$, unique per org).
--   3. Backfills both from the existing slug, deriving with the SAME algorithm
--      as deriveNamespace() in packages/database/src/namespace.ts (kept in
--      lockstep). SET NOT NULL after backfill.
--   4. Installs immutability triggers: once set, a namespace can never change,
--      and an agent's slug can never change (immutable-by-convention becomes
--      immutable-by-constraint).
--   5. Caps NEW agent slugs at 18 chars via a BEFORE INSERT trigger (NOT a
--      CHECK — a CHECK would also reject UPDATEs of grandfathered longer slugs;
--      an INSERT-only trigger leaves existing rows fully updatable).

-- ── Columns (nullable first; backfilled, then set NOT NULL) ───────────────────
ALTER TABLE "org"."organizations" ADD COLUMN "namespace" public.citext;
ALTER TABLE "workspace"."workspaces" ADD COLUMN "namespace" public.citext;

-- ── Backfill organizations.namespace (globally unique) ────────────────────────
-- Mirrors deriveNamespace(): normalize slug to [a-z0-9], pad to ≥2, first
-- candidate = left(base,6); on collision append the smallest numeric suffix that
-- keeps total ≤6, truncating the base as the suffix grows. Personal orgs with an
-- empty slug fall back to the uuid hex (always ≥6 hex chars, all in [a-z0-9]).
DO $$
DECLARE
  r        RECORD;
  base     text;
  cand     text;
  n        int;
  suffix   text;
  keep     int;
BEGIN
  FOR r IN
    SELECT id, slug FROM org.organizations ORDER BY created_at, id
  LOOP
    base := regexp_replace(
      lower(coalesce(nullif(r.slug::text, ''), replace(r.id::text, '-', ''))),
      '[^a-z0-9]', '', 'g'
    );
    IF length(base) < 2 THEN
      base := left(base || '00', 2);
    END IF;

    cand := left(base, 6);
    n := 0;
    WHILE EXISTS (SELECT 1 FROM org.organizations WHERE namespace = cand::public.citext) LOOP
      n := n + 1;
      suffix := n::text;
      keep := greatest(1, 6 - length(suffix));
      cand := left(left(base, keep) || suffix, 6);
    END LOOP;

    UPDATE org.organizations SET namespace = cand::public.citext WHERE id = r.id;
  END LOOP;
END
$$;

-- ── Backfill workspaces.namespace (unique per org) ────────────────────────────
DO $$
DECLARE
  r        RECORD;
  base     text;
  cand     text;
  n        int;
  suffix   text;
  keep     int;
BEGIN
  FOR r IN
    SELECT id, org_id, slug FROM workspace.workspaces ORDER BY created_at, id
  LOOP
    base := regexp_replace(
      lower(coalesce(nullif(r.slug::text, ''), replace(r.id::text, '-', ''))),
      '[^a-z0-9]', '', 'g'
    );
    IF length(base) < 2 THEN
      base := left(base || '00', 2);
    END IF;

    cand := left(base, 6);
    n := 0;
    WHILE EXISTS (
      SELECT 1 FROM workspace.workspaces
      WHERE org_id = r.org_id AND namespace = cand::public.citext
    ) LOOP
      n := n + 1;
      suffix := n::text;
      keep := greatest(1, 6 - length(suffix));
      cand := left(left(base, keep) || suffix, 6);
    END LOOP;

    UPDATE workspace.workspaces SET namespace = cand::public.citext WHERE id = r.id;
  END LOOP;
END
$$;

-- ── Constrain: NOT NULL + format CHECK + UNIQUE ───────────────────────────────
ALTER TABLE "org"."organizations" ALTER COLUMN "namespace" SET NOT NULL;
ALTER TABLE "workspace"."workspaces" ALTER COLUMN "namespace" SET NOT NULL;

ALTER TABLE "org"."organizations"
  ADD CONSTRAINT "organizations_namespace_check" CHECK ("namespace" ~ '^[a-z0-9]{2,6}$');
ALTER TABLE "workspace"."workspaces"
  ADD CONSTRAINT "workspaces_namespace_check" CHECK ("namespace" ~ '^[a-z0-9]{2,6}$');

-- organizations.namespace is globally unique; workspaces.namespace is unique
-- only within an org (mirrors the (org_id, slug) uniqueness).
CREATE UNIQUE INDEX "organizations_namespace_idx"
  ON "org"."organizations" ("namespace");
CREATE UNIQUE INDEX "workspaces_org_namespace_idx"
  ON "workspace"."workspaces" ("org_id", "namespace");

-- ── Immutability: namespaces never change once set ────────────────────────────
-- A generic guard reused for both organizations and workspaces (it only reads
-- NEW.namespace / OLD.namespace). SECURITY INVOKER (default): it runs with the
-- firing role's privileges, which is correct for a pure validation trigger.
CREATE OR REPLACE FUNCTION public.enforce_namespace_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD.namespace IS NOT NULL AND NEW.namespace IS DISTINCT FROM OLD.namespace THEN
    RAISE EXCEPTION 'namespace is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "organizations_namespace_immutable" ON "org"."organizations";
CREATE TRIGGER "organizations_namespace_immutable"
  BEFORE UPDATE ON "org"."organizations"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_namespace_immutable();

DROP TRIGGER IF EXISTS "workspaces_namespace_immutable" ON "workspace"."workspaces";
CREATE TRIGGER "workspaces_namespace_immutable"
  BEFORE UPDATE ON "workspace"."workspaces"
  FOR EACH ROW EXECUTE FUNCTION public.enforce_namespace_immutable();

-- ── Agent slug immutability (was convention-only) ─────────────────────────────
CREATE OR REPLACE FUNCTION agent.enforce_agent_slug_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION 'agent slug is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "agents_slug_immutable" ON "agent"."agents";
CREATE TRIGGER "agents_slug_immutable"
  BEFORE UPDATE ON "agent"."agents"
  FOR EACH ROW EXECUTE FUNCTION agent.enforce_agent_slug_immutable();

-- ── New-agent slug length cap (INSERT-only, grandfathers longer rows) ─────────
-- 18 = the agent-slug budget in a 32-char key (6 + 1 + 6 + 1 + 18). Enforced as
-- an INSERT trigger, NOT a CHECK, so pre-existing agents with longer slugs stay
-- fully updatable (a CHECK would reject their every UPDATE).
CREATE OR REPLACE FUNCTION agent.enforce_agent_slug_length()
RETURNS trigger AS $$
BEGIN
  IF char_length(NEW.slug) > 18 THEN
    RAISE EXCEPTION 'agent slug exceeds 18 characters (new agents are capped for the 32-char agentKey budget)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "agents_slug_length" ON "agent"."agents";
CREATE TRIGGER "agents_slug_length"
  BEFORE INSERT ON "agent"."agents"
  FOR EACH ROW EXECUTE FUNCTION agent.enforce_agent_slug_length();
