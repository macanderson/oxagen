-- A repository head can take the role steering (lane S0, #4387).
--
-- The steering repo spec gives every workspace one repository Oxagen creates
-- and holds: its steering repo. It belongs to exactly one workspace and is
-- never linked. The binding role that names it is `steering`. Today that role
-- is `main` (ADR-099). Provisioning (lane S1) binds each new steering repo as
-- `steering`, and lane S8 later moves every `main` row to `steering` and drops
-- `main`. Until S8 lands, both roles are exclusive, and this migration only
-- widens the guards to cover the new one:
--
--   1. The role check admits `steering` beside `main` and `linked`.
--   2. The partial unique index repository_binding_heads_main_repository_uq
--      covers both roles, so one repository is the main or steering
--      repository of at most one workspace anywhere. It keeps its name,
--      because the handlers map a 23505 on it to `main_repo_claimed`.
--   3. The trigger repository_binding_heads_exclusive_main treats `steering`
--      exactly as `main`. It keeps its name, its lock, and the constraint
--      names it raises.
--
-- No head has the role `steering` yet, so the wider index and trigger refuse
-- nothing the old ones allowed.
--
-- packages/database/src/schema/ingestion.ts still declares the old check and
-- the index's `role = 'main'` predicate. Lane S8 owns that file and brings it
-- in line when it removes `main`.

-- ── 1. The role check ────────────────────────────────────────────────────────
ALTER TABLE "ingestion"."repository_binding_heads"
  DROP CONSTRAINT IF EXISTS "repository_binding_heads_role_check";
ALTER TABLE "ingestion"."repository_binding_heads"
  ADD CONSTRAINT "repository_binding_heads_role_check"
  CHECK ("role" IN ('main', 'linked', 'steering'));

-- ── 2. The exclusivity index ─────────────────────────────────────────────────
DROP INDEX IF EXISTS "ingestion"."repository_binding_heads_main_repository_uq";
CREATE UNIQUE INDEX "repository_binding_heads_main_repository_uq"
  ON "ingestion"."repository_binding_heads" ("provider", "provider_repository_id")
  WHERE "role" IN ('main', 'steering');

-- ── 3. The trigger ───────────────────────────────────────────────────────────
-- The body is 20260918200000's with every `= 'main'` read as "main or
-- steering". The trigger itself is unchanged: it calls the function by name.
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
   -- An exclusive head elsewhere wins the message over a linked one.
   ORDER BY (h."role" IN ('main', 'steering')) DESC
   LIMIT 1;
  PERFORM set_config('app.rls_bypass', coalesce(saved_bypass, ''), true);

  IF other_role IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."role" IN ('main', 'steering') THEN
    IF other_role IN ('main', 'steering') THEN
      RAISE EXCEPTION
        'repository %:% is already the % repository of another workspace',
        NEW."provider", NEW."provider_repository_id", other_role
        USING ERRCODE = '23505',
              CONSTRAINT = 'repository_binding_heads_main_repository_uq',
              TABLE = 'repository_binding_heads',
              SCHEMA = 'ingestion';
    END IF;
    RAISE EXCEPTION
      'repository %:% is linked to another workspace and cannot become a % repository',
      NEW."provider", NEW."provider_repository_id", NEW."role"
      USING ERRCODE = '23505',
            CONSTRAINT = 'repository_binding_heads_main_is_linked_elsewhere',
            TABLE = 'repository_binding_heads',
            SCHEMA = 'ingestion';
  END IF;

  IF other_role IN ('main', 'steering') THEN
    RAISE EXCEPTION
      'repository %:% is the % repository of another workspace and cannot be linked',
      NEW."provider", NEW."provider_repository_id", other_role
      USING ERRCODE = '23505',
            CONSTRAINT = 'repository_binding_heads_linked_is_main_elsewhere',
            TABLE = 'repository_binding_heads',
            SCHEMA = 'ingestion';
  END IF;

  RETURN NEW;
END
$$;
