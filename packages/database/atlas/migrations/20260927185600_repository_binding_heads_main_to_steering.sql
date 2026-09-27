-- Every `main` head becomes `steering`, and the role `main` is gone (lane S8,
-- ADR-212).
--
-- ADR-099 named a workspace's steering source its main repository: a code
-- repository whose `.oxagen/` tree steered the workspace. The steering repo
-- spec replaces it with the steering repo, which Oxagen creates and holds, and
-- 20260926120000 added the role `steering` beside `main` so the two could live
-- together until this migration. From here on a workspace has one steering
-- record source, `steering`, and any number of `linked` code repositories. A
-- linked repository may be linked to many workspaces.
--
--   1. Each workspace keeps one steering head. If it already holds a
--      `steering` head (lane S1 provisioned one), the oldest of those stays
--      and every `main` head becomes `linked`. Otherwise its oldest `main`
--      head becomes `steering` and any other becomes `linked`.
--   2. The role loses its default. The one writer, writeRepositoryHead, always
--      names the role, and no role is a safe guess for a row that forgot one.
--   3. The role check admits only `linked` and `steering`.
--   4. repository_binding_heads_main_repository_uq covers `steering` alone. It
--      keeps its name, because the handlers map a 23505 on it to
--      `main_repo_claimed`.
--   5. repository_binding_heads_workspace_steering_uq holds one steering head
--      per workspace.
--   6. The trigger's function reads `steering` where it read "main or
--      steering". It keeps its lock and the three constraint names it raises.
--
-- Why a demotion to `linked` passes the trigger: a `main` or `steering` head
-- is exclusive, so no other workspace holds any head for its repository. The
-- trigger refuses a linked head only when another workspace holds that
-- repository as its steering source, and none does. No head is deleted, no
-- binding version is dropped, and no connection is touched. A workspace owner
-- can unlink a demoted repository the usual way.

-- ── 1. Move every main head ──────────────────────────────────────────────────
-- Ranked per workspace: a `steering` head before a `main` one, then oldest
-- first, with `id` breaking a tie on equal timestamps. Rank 1 is the
-- workspace's steering head and every other head in the set becomes linked.
-- A row already in its target role is left alone. Each change is raised as a
-- NOTICE so the apply log names every workspace it touched.
DO $$
DECLARE
  moved record;
  n integer := 0;
BEGIN
  FOR moved IN
    WITH ranked AS (
      SELECT h."id",
             h."role" AS old_role,
             CASE
               WHEN row_number() OVER (
                      PARTITION BY h."workspace_id"
                      ORDER BY (h."role" = 'steering') DESC,
                               h."created_at",
                               h."id"
                    ) = 1
                 THEN 'steering'
               ELSE 'linked'
             END AS new_role
        FROM "ingestion"."repository_binding_heads" AS h
       WHERE h."role" IN ('main', 'steering')
    )
    UPDATE "ingestion"."repository_binding_heads" AS h
       SET "role" = r.new_role,
           "updated_at" = now()
      FROM ranked AS r
     WHERE r."id" = h."id"
       AND r.old_role <> r.new_role
    RETURNING h."org_id", h."workspace_id", h."provider",
              h."provider_repository_id", r.old_role, r.new_role
  LOOP
    n := n + 1;
    RAISE NOTICE
      'repository_binding_heads: % -> % for org % workspace % on %:%',
      moved.old_role, moved.new_role, moved."org_id", moved."workspace_id",
      moved."provider", moved."provider_repository_id";
  END LOOP;
  RAISE NOTICE 'repository_binding_heads: % head(s) moved off the main role', n;
END
$$;

-- ── 2. No default role ───────────────────────────────────────────────────────
ALTER TABLE "ingestion"."repository_binding_heads"
  ALTER COLUMN "role" DROP DEFAULT;

-- ── 3. The role check ────────────────────────────────────────────────────────
ALTER TABLE "ingestion"."repository_binding_heads"
  DROP CONSTRAINT IF EXISTS "repository_binding_heads_role_check";
ALTER TABLE "ingestion"."repository_binding_heads"
  ADD CONSTRAINT "repository_binding_heads_role_check"
  CHECK ("role" IN ('linked', 'steering'));

-- ── 4. One workspace per steering repository ─────────────────────────────────
DROP INDEX IF EXISTS "ingestion"."repository_binding_heads_main_repository_uq";
CREATE UNIQUE INDEX "repository_binding_heads_main_repository_uq"
  ON "ingestion"."repository_binding_heads" ("provider", "provider_repository_id")
  WHERE "role" = 'steering';

-- ── 5. One steering repository per workspace ─────────────────────────────────
CREATE UNIQUE INDEX "repository_binding_heads_workspace_steering_uq"
  ON "ingestion"."repository_binding_heads" ("workspace_id")
  WHERE "role" = 'steering';

-- ── 6. The trigger ───────────────────────────────────────────────────────────
-- The body is 20260926120000's with every `IN ('main', 'steering')` read as
-- `= 'steering'`. The trigger itself is unchanged: it calls the function by
-- name.
CREATE OR REPLACE FUNCTION "ingestion"."repository_binding_heads_guard_exclusive_main"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  saved_bypass text;
  other_role text;
BEGIN
  -- Every writer of a head for this repository, anywhere, queues here.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'repository_binding_heads:' || NEW.provider || ':' || NEW.provider_repository_id,
    0
  ));

  -- Read the other workspaces' heads with the bypass the policy already
  -- honours, then put the GUC back exactly as it was.
  saved_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT h."role"
    INTO other_role
    FROM "ingestion"."repository_binding_heads" AS h
   WHERE h."provider" = NEW."provider"
     AND h."provider_repository_id" = NEW."provider_repository_id"
     AND h."workspace_id" <> NEW."workspace_id"
     AND h."id" <> NEW."id"
   -- A steering head elsewhere wins the message over a linked one.
   ORDER BY (h."role" = 'steering') DESC
   LIMIT 1;
  PERFORM set_config('app.rls_bypass', coalesce(saved_bypass, ''), true);

  IF other_role IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."role" = 'steering' THEN
    IF other_role = 'steering' THEN
      RAISE EXCEPTION
        'repository %:% is already the steering repository of another workspace',
        NEW."provider", NEW."provider_repository_id"
        USING ERRCODE = '23505',
              CONSTRAINT = 'repository_binding_heads_main_repository_uq',
              TABLE = 'repository_binding_heads',
              SCHEMA = 'ingestion';
    END IF;
    RAISE EXCEPTION
      'repository %:% is linked to another workspace and cannot become a steering repository',
      NEW."provider", NEW."provider_repository_id"
      USING ERRCODE = '23505',
            CONSTRAINT = 'repository_binding_heads_main_is_linked_elsewhere',
            TABLE = 'repository_binding_heads',
            SCHEMA = 'ingestion';
  END IF;

  IF other_role = 'steering' THEN
    RAISE EXCEPTION
      'repository %:% is the steering repository of another workspace and cannot be linked',
      NEW."provider", NEW."provider_repository_id"
      USING ERRCODE = '23505',
            CONSTRAINT = 'repository_binding_heads_linked_is_main_elsewhere',
            TABLE = 'repository_binding_heads',
            SCHEMA = 'ingestion';
  END IF;

  RETURN NEW;
END
$$;
