-- ADR-192: an agent is one operator on one runtime with one harness, it
-- carries a toolbelt instead of a definition file, and each change of runtime
-- or toolbelt writes an agent version (#4369).
--
-- 1. agent.runtimes: a named place agents run, with a slug unique among the
--    workspace's live runtimes.
-- 2. tools.toolbelts and tools.toolbelt_tools: the workspace's All tools belt
--    and the belts cloned from it.
-- 3. agent.tools.default_active: whether a tool starts active in a belt.
-- 4. agent.agents.runtime_id / toolbelt_id and tacho.hosts.runtime_id.
-- 5. agent.agent_versions: the runtime, toolbelt and change kind of each
--    version. The definition-file cache columns (ADR-057 decision 1) go, after
--    the budget and containment tables they held are copied into `config`,
--    the column the host bundle already reads when no file text exists.
-- 6. Backfill: one runtime per distinct hostname in each workspace, each host
--    bound to it, each live agent placed on its newest host's runtime unless
--    another live agent with the same harness already holds that runtime, one
--    All tools belt per workspace, and every agent given its workspace's belt.
-- 7. The one-live-agent-per-runtime-and-harness index, after the backfill has
--    placed at most one agent in each pair.
--
-- RLS for the three new tables is class `standard`, as
-- tools/scripts/gen-rls-migration.ts emits it. The backfill runs with the
-- bypass set for this transaction only. Hand-written, then `atlas migrate hash`.
--
-- Rollback:
--   DROP INDEX IF EXISTS agent.agents_runtime_harness_uniq;
--   ALTER TABLE agent.agents DROP COLUMN runtime_id, DROP COLUMN toolbelt_id;
--   ALTER TABLE agent.agent_versions DROP COLUMN runtime_id,
--     DROP COLUMN toolbelt_id, DROP COLUMN change_kind;
--   ALTER TABLE tacho.hosts DROP COLUMN runtime_id;
--   ALTER TABLE agent.tools DROP COLUMN default_active;
--   DROP TABLE tools.toolbelt_tools; DROP TABLE tools.toolbelts;
--   DROP TABLE agent.runtimes;
--   The dropped definition columns do not come back with their text.

-- ── 1. agent.runtimes ────────────────────────────────────────────────────────
CREATE TABLE "agent"."runtimes" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL)
      THEN public.uuid_generate_v7() ELSE public.uuid_generate_v4() END,
    public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid NULL,
  "updated_by_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "runtimes_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "runtimes_slug_check"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 40),
  CONSTRAINT "runtimes_name_check"
    CHECK (char_length(btrim("name")) BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX "runtimes_workspace_slug_uniq"
  ON "agent"."runtimes" ("workspace_id", "slug") WHERE ("deleted_at" IS NULL);
CREATE INDEX "runtimes_org_idx" ON "agent"."runtimes" ("org_id", "workspace_id");

COMMENT ON TABLE "agent"."runtimes" IS
  'A named place agents run: a laptop, a VM, a cloud workspace (ADR-192). tacho.hosts rows bind a machine to it; the runtime outlives any one machine.';

-- ── 2. tools.toolbelts and tools.toolbelt_tools ─────────────────────────────
CREATE TABLE "tools"."toolbelts" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL)
      THEN public.uuid_generate_v7() ELSE public.uuid_generate_v4() END,
    public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid NULL,
  "updated_by_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_id" uuid NULL,
  "name" text NOT NULL,
  "slug" public.citext NOT NULL,
  "description" text NULL,
  "kind" text NOT NULL DEFAULT 'custom',
  "cloned_from_id" uuid NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "toolbelts_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "toolbelts_cloned_from_id_toolbelts_id_fk"
    FOREIGN KEY ("cloned_from_id") REFERENCES "tools"."toolbelts" ("id"),
  CONSTRAINT "toolbelts_kind_check" CHECK ("kind" IN ('all_tools', 'custom')),
  CONSTRAINT "toolbelts_slug_check"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") <= 40)
);
CREATE UNIQUE INDEX "toolbelts_workspace_slug_uniq"
  ON "tools"."toolbelts" ("workspace_id", "slug") WHERE ("deleted_at" IS NULL);
CREATE UNIQUE INDEX "toolbelts_all_tools_uniq"
  ON "tools"."toolbelts" ("workspace_id")
  WHERE ("kind" = 'all_tools' AND "deleted_at" IS NULL);
CREATE INDEX "toolbelts_org_idx" ON "tools"."toolbelts" ("org_id", "workspace_id");

COMMENT ON TABLE "tools"."toolbelts" IS
  'The set of tools an agent is shown (ADR-192). One all_tools belt per workspace holds every available tool and stores no members; a custom belt is a clone with its own members.';

CREATE TABLE "tools"."toolbelt_tools" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL)
      THEN public.uuid_generate_v7() ELSE public.uuid_generate_v4() END,
    public.uuid_generate_v4()),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid NULL,
  "updated_by_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "toolbelt_id" uuid NOT NULL,
  "tool_id" uuid NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  PRIMARY KEY ("id"),
  CONSTRAINT "toolbelt_tools_toolbelt_id_toolbelts_id_fk"
    FOREIGN KEY ("toolbelt_id") REFERENCES "tools"."toolbelts" ("id")
);
CREATE UNIQUE INDEX "toolbelt_tools_member_uniq"
  ON "tools"."toolbelt_tools" ("toolbelt_id", "tool_id");
CREATE INDEX "toolbelt_tools_tool_idx" ON "tools"."toolbelt_tools" ("tool_id");
CREATE INDEX "toolbelt_tools_org_idx" ON "tools"."toolbelt_tools" ("org_id", "workspace_id");

COMMENT ON TABLE "tools"."toolbelt_tools" IS
  'A custom belt''s members: one agent.tools row each, active or not. Removing a server from the belt deletes its rows.';

-- Tenant + workspace RLS, class `standard` (tools/scripts/gen-rls-migration.ts).
ALTER TABLE agent.runtimes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.runtimes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent.runtimes;
CREATE POLICY tenant_isolation ON agent.runtimes
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tools.toolbelts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools.toolbelts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tools.toolbelts;
CREATE POLICY tenant_isolation ON tools.toolbelts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE tools.toolbelt_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE tools.toolbelt_tools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tools.toolbelt_tools;
CREATE POLICY tenant_isolation ON tools.toolbelt_tools
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- oxagen_app grants: guarded, fresh clusters may lack the role. A belt's
-- members are deleted when a server leaves the belt.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON agent.runtimes TO oxagen_app';
    EXECUTE 'GRANT USAGE ON SCHEMA tools TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tools.toolbelts TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tools.toolbelt_tools TO oxagen_app';
  END IF;
END
$$;

-- ── 3. agent.tools.default_active ───────────────────────────────────────────
ALTER TABLE "agent"."tools"
  ADD COLUMN "default_active" boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN "agent"."tools"."enabled" IS
  'An owner or admin made the tool available to toolbelts (ADR-192). Off takes it out of every belt.';
COMMENT ON COLUMN "agent"."tools"."default_active" IS
  'Whether the tool starts active in a belt: its state in the All tools belt and in a clone made from it.';

-- ── 4. Current runtime and toolbelt ─────────────────────────────────────────
ALTER TABLE "agent"."agents"
  ADD COLUMN "runtime_id" uuid NULL,
  ADD COLUMN "toolbelt_id" uuid NULL,
  ADD CONSTRAINT "agents_runtime_id_runtimes_id_fk"
    FOREIGN KEY ("runtime_id") REFERENCES "agent"."runtimes" ("id");
CREATE INDEX "agents_runtime_idx" ON "agent"."agents" ("runtime_id")
  WHERE ("runtime_id" IS NOT NULL);
COMMENT ON COLUMN "agent"."agents"."runtime_id" IS
  'The runtime the agent runs on now (ADR-192). Each change writes an agent_versions row.';
COMMENT ON COLUMN "agent"."agents"."toolbelt_id" IS
  'The toolbelt the agent carries now (tools.toolbelts, app-enforced). Null reads as the workspace''s All tools belt.';

ALTER TABLE "tacho"."hosts" ADD COLUMN "runtime_id" uuid NULL;
CREATE INDEX "tacho_hosts_runtime_idx" ON "tacho"."hosts" ("runtime_id")
  WHERE ("runtime_id" IS NOT NULL);
COMMENT ON COLUMN "tacho"."hosts"."runtime_id" IS
  'The runtime this enrollment binds (agent.runtimes, app-enforced; ADR-192).';

-- ── 5. Agent versions ───────────────────────────────────────────────────────
SELECT set_config('app.rls_bypass', 'on', true);

-- The file text owned the budget and containment tables whenever it was
-- present (tacho-mandate.ts, budgetDocFromVersion), so those two keys are
-- replaced from the text, never merged with what config held.
UPDATE "agent"."agent_versions" AS v
SET config = (v.config - 'budget' - 'containment') || jsonb_strip_nulls(jsonb_build_object(
    'budget', CASE
      WHEN f.run IS NULL AND f.day IS NULL THEN NULL
      ELSE jsonb_strip_nulls(jsonb_build_object('per_run_micros', f.run, 'per_day_micros', f.day))
    END,
    'containment', CASE WHEN f.contained THEN jsonb_build_object('required', true) END))
FROM (
  SELECT
    id,
    replace(substring(definition_source FROM 'per_run_micros\s*=\s*([0-9_]+)'), '_', '')::bigint AS run,
    replace(substring(definition_source FROM 'per_day_micros\s*=\s*([0-9_]+)'), '_', '')::bigint AS day,
    definition_source ~ '\[containment\][^\[]*required\s*=\s*true' AS contained
  FROM "agent"."agent_versions"
  WHERE definition_source IS NOT NULL
) AS f
WHERE v.id = f.id;

ALTER TABLE "agent"."agent_versions"
  DROP COLUMN "definition_path",
  DROP COLUMN "definition_digest",
  DROP COLUMN "definition_source",
  DROP COLUMN "commit_sha",
  DROP COLUMN "branch",
  DROP COLUMN "pull_request_url",
  ADD COLUMN "runtime_id" uuid NULL,
  ADD COLUMN "toolbelt_id" uuid NULL,
  ADD COLUMN "change_kind" text NOT NULL DEFAULT 'legacy',
  ADD CONSTRAINT "agent_versions_runtime_id_runtimes_id_fk"
    FOREIGN KEY ("runtime_id") REFERENCES "agent"."runtimes" ("id"),
  ADD CONSTRAINT "agent_versions_change_kind_check"
    CHECK ("change_kind" IN ('registered', 'runtime_changed', 'toolbelt_changed', 'legacy'));
COMMENT ON COLUMN "agent"."agent_versions"."change_kind" IS
  'Why the version exists: registered, runtime_changed, toolbelt_changed, or legacy for a row written before ADR-192.';

-- ── 6. Backfill ─────────────────────────────────────────────────────────────
-- One runtime per distinct hostname in a workspace, named by the hostname.
-- The slug follows slugFromName: lowercase, a trailing ".local" dropped,
-- every character other than a letter, a digit, a space or a hyphen dropped,
-- each run of spaces and hyphens one hyphen, at most 40 characters. A second
-- hostname with the same slug takes a numeric suffix.
WITH hosts AS (
  SELECT
    h.org_id,
    h.workspace_id,
    h.created_at,
    COALESCE(NULLIF(left(btrim(h.hostname), 128), ''), 'Unnamed runtime') AS name
  FROM "tacho"."hosts" AS h
),
names AS (
  SELECT DISTINCT ON (h.workspace_id, lower(h.name))
    h.org_id,
    h.workspace_id,
    h.name,
    COALESCE(
      NULLIF(btrim(left(btrim(regexp_replace(regexp_replace(
        lower(regexp_replace(h.name, '\.local$', '', 'i')),
        '[^a-z0-9[:space:]-]', '', 'g'), '[[:space:]-]+', '-', 'g'), '-'), 40), '-'), ''),
      'runtime') AS base_slug,
    h.created_at
  FROM hosts AS h
  ORDER BY h.workspace_id, lower(h.name), h.created_at
),
numbered AS (
  SELECT n.*, row_number() OVER (PARTITION BY n.workspace_id, n.base_slug ORDER BY n.created_at) AS k
  FROM names AS n
)
INSERT INTO "agent"."runtimes" ("public_id", "org_id", "workspace_id", "name", "slug", "created_at", "updated_at")
SELECT
  'rtm_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
  org_id,
  workspace_id,
  name,
  CASE WHEN k = 1 THEN base_slug ELSE rtrim(left(base_slug, 36), '-') || '-' || k END,
  created_at,
  created_at
FROM numbered;

UPDATE "tacho"."hosts" AS h
SET runtime_id = r.id
FROM "agent"."runtimes" AS r
WHERE r.workspace_id = h.workspace_id
  AND r.deleted_at IS NULL
  AND lower(r.name) = lower(COALESCE(NULLIF(left(btrim(h.hostname), 128), ''), 'Unnamed runtime'));

-- Each live agent goes on the runtime of its newest host, a live host first.
-- Where two live agents with one harness share a runtime, the newer agent
-- keeps it and the older one is left unplaced for its owner to move.
WITH placed AS (
  SELECT DISTINCT ON (a.id)
    a.id AS agent_id, a.workspace_id, a.harness, a.created_at, h.runtime_id
  FROM "agent"."agents" AS a
  JOIN "tacho"."hosts" AS h ON h.agent_id = a.id AND h.runtime_id IS NOT NULL
  WHERE a.deleted_at IS NULL AND a.status <> 'archived'
  ORDER BY a.id, (h.status <> 'revoked') DESC, h.created_at DESC
),
kept AS (
  SELECT DISTINCT ON (workspace_id, runtime_id, harness) agent_id, runtime_id
  FROM placed
  ORDER BY workspace_id, runtime_id, harness, created_at DESC
)
UPDATE "agent"."agents" AS a
SET runtime_id = k.runtime_id
FROM kept AS k
WHERE a.id = k.agent_id;

-- One All tools belt per workspace.
INSERT INTO "tools"."toolbelts" ("public_id", "org_id", "workspace_id", "name", "slug", "kind")
SELECT
  'tbt_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 22),
  w.org_id,
  w.id,
  'All tools',
  'all-tools',
  'all_tools'
FROM "workspace"."workspaces" AS w
ON CONFLICT DO NOTHING;

UPDATE "agent"."agents" AS a
SET toolbelt_id = b.id
FROM "tools"."toolbelts" AS b
WHERE b.workspace_id = a.workspace_id
  AND b.kind = 'all_tools'
  AND b.deleted_at IS NULL
  AND a.toolbelt_id IS NULL;

SELECT set_config('app.rls_bypass', '', true);

-- ── 7. One live agent per runtime and harness ───────────────────────────────
CREATE UNIQUE INDEX "agents_runtime_harness_uniq"
  ON "agent"."agents" ("workspace_id", "runtime_id", "harness")
  WHERE ("runtime_id" IS NOT NULL AND "deleted_at" IS NULL AND "status" <> 'archived');
