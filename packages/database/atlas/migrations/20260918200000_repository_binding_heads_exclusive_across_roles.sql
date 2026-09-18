-- The main rule holds in both directions, at the store, and a head can be
-- deleted.
--
-- Three defects in the model 20260918040000_repository_main_binding_is_exclusive
-- landed, all found in review of #3326. This migration repairs them in one
-- file, because they are parts of the same invariant: a head is the mutable
-- pointer "this workspace sees this repository", and the store, not the
-- handler, is what holds the rule about which pointers may coexist.
--
-- ## 1. `unlink_repository` deletes a head, and the role could not
--
-- 20260813100000_run_attempt_foundation_expand.sql revoked DELETE on
-- ingestion.repository_binding_heads from oxagen_app, alongside the evidence
-- tables it made append-only. At the time nothing deleted a head. ADR-099 §5
-- now says unlinking a repository DELETES its head (packages/handlers/src/
-- repository.unlink.ts), so in production every unlink fails with 42501.
--
-- The grant is right because of what a head is. `ingestion.repository_bindings`
-- is evidence: a version admitted runs cite, and it stays append-only, with
-- its REVOKE untouched here. A head is not evidence. It is the pointer
-- admission resolves and then copies out of, so that moving or removing the
-- head afterwards can never rewrite what an admitted run claims (the table
-- comment in packages/database/src/schema/ingestion.ts). Removing the pointer
-- is exactly what "this workspace no longer sees this repository" means, and
-- the binding versions it pointed at remain for every run that cited them.
--
-- ## 2. The exclusive-main rule was one-directional and racy
--
-- `repository_binding_heads_main_repository_uq` refuses a second MAIN head for
-- a repository. It says nothing about a LINKED head, so before this migration:
--
--   - `link_repository` refused a repository that is main elsewhere, but
--     `create_workspace` and `bind_main_repository` did not refuse a
--     repository that is LINKED elsewhere. Workspace A links X; workspace B
--     then claims X as its main. B's `.oxagen/` governance tree now lives in a
--     repository A opens Context PRs on, which is the door ADR-099 §4 closes
--     in the other direction.
--   - Nothing serialised a link against a concurrent main claim. The unique
--     index only sees main against main, and the handlers' advisory lock is
--     keyed on the workspace, so a link in A and a main claim in B for the
--     same repository never wait for each other. Both pre-checks pass, both
--     writes commit.
--
-- A handler pre-check can give the ordinary case a sentence. Only the store
-- can give the racing case a refusal, so the rule becomes a trigger on the
-- heads table, BEFORE INSERT OR UPDATE OF the columns that decide it.
--
-- ### The lock
--
-- The trigger takes `pg_advisory_xact_lock` keyed on the REPOSITORY
-- ('repository_binding_heads:' || provider || ':' || provider_repository_id),
-- so every writer of a head for one repository, in any workspace of any
-- organisation, serialises before it reads the other heads. The second writer
-- then reads the first writer's committed head and refuses.
--
-- Lock order, and why it cannot deadlock: the handlers already hold a
-- transaction-scoped advisory lock keyed on the WORKSPACE
-- (`workspaceRepositoriesLock` in packages/handlers/src/repository.main.bind.ts)
-- when the trigger fires, so every transaction acquires locks in one order,
-- workspace then repository. A transaction writes at most one head, so it
-- takes at most one repository key, and two transactions in one workspace
-- never reach the repository key together because the workspace key already
-- serialised them. Two transactions in different workspaces hold different
-- workspace keys and contend only on the repository key, which is a queue,
-- not a cycle. `create_workspace` holds no workspace key (the workspace does
-- not exist before its transaction) and so takes only the repository one.
--
-- ### The read, and why the function is not SECURITY DEFINER
--
-- The heads table is under FORCE ROW LEVEL SECURITY, and the policy
-- (20260917120000_org_wide_read_mode.sql) narrows every read to the caller's
-- workspace. The trigger has to see the OTHER workspaces' heads. The policy
-- already recognises one bypass, `app.rls_bypass = 'on'`, the GUC
-- `withSystemDb` sets, so the function saves the current value, sets the GUC
-- for the read, and restores it, all transaction-local. A SECURITY DEFINER
-- function would reach the same rows by running as the table owner, but it
-- would be a second bypass the store did not have before, owned by a function
-- body rather than by the tenancy seam, and `search_path` and privilege
-- hygiene would then have to be argued for it. Using the GUC the store already
-- honours adds no new way past RLS.
--
-- ### What it refuses
--
-- With every other workspace's head for the repository in view (the row being
-- written is excluded by id, so an UPDATE does not see itself):
--
--   NEW.role = 'main'   and a MAIN head exists elsewhere
--     -> 23505, constraint repository_binding_heads_main_repository_uq
--        (the index's own name, so the handlers' existing mapping to
--        `conflict: main_repo_claimed` keeps working)
--   NEW.role = 'main'   and a LINKED head exists elsewhere
--     -> 23505, constraint repository_binding_heads_main_is_linked_elsewhere
--        (`conflict: repository_linked_elsewhere`)
--   NEW.role = 'linked' and a MAIN head exists elsewhere
--     -> 23505, constraint repository_binding_heads_linked_is_main_elsewhere
--        (`conflict: main_repo_claimed`)
--
-- A linked head beside another workspace's linked head is the many-to-many
-- case §10.1 allows and passes. A main head beside a linked head in the SAME
-- workspace is `link_repository`'s own `conflict: main_repo` and is not this
-- trigger's business. When both a main and a linked head exist elsewhere,
-- the main one wins the message; section 2 below removes the pairs that
-- already exist, so from the trigger on the case is only ever a race.
--
-- The index stays. It is cheap, it holds the main-against-main case without
-- the trigger's read, and it is what the schema in ingestion.ts declares.
--
-- ## 3. The pairs the trigger forbids may already be in the table
--
-- A forward-only trigger inspects the row being written and nothing else.
-- 20260918040000 kept the OLDEST main claim on a repository and demoted every
-- later one to 'linked', so an upgraded database can hold exactly the state
-- this migration forbids: the repository main in workspace A and linked in
-- workspace B. The trigger never sees those rows, the handlers' pre-checks
-- never see them either (both read the row being written), and B keeps
-- opening Context PRs on A's governance repository — the door ADR-099 §4
-- closes — for as long as the row stands. `link_repository` between #3269
-- and this migration could leave the same pair behind a lost race, since its
-- pre-check was not serialised against a concurrent main claim.
--
-- The repair runs BEFORE the trigger is installed and is the same move
-- `unlink_repository` makes: the linked head is deleted, its binding versions
-- stay as evidence for every run that cited them, and no connection is
-- touched. The main head is kept, because it is the claim steering resolved
-- against up to now; removing it instead would silently move A's governance.
-- B is left as the demotion already left it in effect — a workspace that
-- cannot be steered by that repository — and now the store says so too. If B
-- has no other main head it binds its way out through `bind_main_repository`,
-- which promotes a linked head or reuses a retained version
-- (packages/handlers/src/repository.pg.test.ts). Each removal is a NOTICE
-- naming the workspace, so the deploy log says exactly what changed.

-- ── 1. DELETE on the heads table ─────────────────────────────────────────────
-- Guarded the way 20260813100000 guards its grants: a fresh cluster may lack
-- the role. `ingestion.repository_bindings` keeps its REVOKE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT DELETE ON ingestion.repository_binding_heads TO oxagen_app';
  END IF;
END
$$;

-- ── 2. Reconcile linked heads whose repository is main elsewhere ─────────────
-- Runs before the trigger exists, so the trigger only ever guards rows that
-- already satisfy it. DELETE does not fire the trigger anyway; the order is
-- so the file reads as its invariant does: repair, then guard.
DO $$
DECLARE
  removed record;
  n integer := 0;
BEGIN
  FOR removed IN
    DELETE FROM "ingestion"."repository_binding_heads" AS h
     WHERE h."role" = 'linked'
       AND EXISTS (
         SELECT 1
           FROM "ingestion"."repository_binding_heads" AS m
          WHERE m."role" = 'main'
            AND m."provider" = h."provider"
            AND m."provider_repository_id" = h."provider_repository_id"
            AND m."workspace_id" <> h."workspace_id"
       )
    RETURNING h."org_id", h."workspace_id", h."provider", h."provider_repository_id"
  LOOP
    n := n + 1;
    RAISE NOTICE
      'repository_binding_heads: removed linked head for org % workspace % on %:% (repository is the main repository of another workspace; its binding versions are retained)',
      removed."org_id", removed."workspace_id", removed."provider", removed."provider_repository_id";
  END LOOP;
  IF n > 0 THEN
    RAISE NOTICE 'repository_binding_heads: % linked head(s) removed before installing the exclusive-main trigger', n;
  END IF;
END
$$;

-- ── 3. The trigger ───────────────────────────────────────────────────────────
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
  -- honours, then put the GUC back exactly as it was. `set_config(..., true)`
  -- is transaction-local, so a raised exception below leaves nothing behind
  -- either way.
  saved_bypass := current_setting('app.rls_bypass', true);
  PERFORM set_config('app.rls_bypass', 'on', true);
  SELECT h."role"
    INTO other_role
    FROM "ingestion"."repository_binding_heads" AS h
   WHERE h."provider" = NEW."provider"
     AND h."provider_repository_id" = NEW."provider_repository_id"
     AND h."workspace_id" <> NEW."workspace_id"
     AND h."id" <> NEW."id"
   -- A main head elsewhere wins the message over a linked one.
   ORDER BY (h."role" = 'main') DESC
   LIMIT 1;
  PERFORM set_config('app.rls_bypass', coalesce(saved_bypass, ''), true);

  IF other_role IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."role" = 'main' THEN
    IF other_role = 'main' THEN
      RAISE EXCEPTION
        'repository %:% is already the main repository of another workspace',
        NEW."provider", NEW."provider_repository_id"
        USING ERRCODE = '23505',
              CONSTRAINT = 'repository_binding_heads_main_repository_uq',
              TABLE = 'repository_binding_heads',
              SCHEMA = 'ingestion';
    END IF;
    RAISE EXCEPTION
      'repository %:% is linked to another workspace and cannot become a main repository',
      NEW."provider", NEW."provider_repository_id"
      USING ERRCODE = '23505',
            CONSTRAINT = 'repository_binding_heads_main_is_linked_elsewhere',
            TABLE = 'repository_binding_heads',
            SCHEMA = 'ingestion';
  END IF;

  IF other_role = 'main' THEN
    RAISE EXCEPTION
      'repository %:% is the main repository of another workspace and cannot be linked',
      NEW."provider", NEW."provider_repository_id"
      USING ERRCODE = '23505',
            CONSTRAINT = 'repository_binding_heads_linked_is_main_elsewhere',
            TABLE = 'repository_binding_heads',
            SCHEMA = 'ingestion';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "repository_binding_heads_exclusive_main"
  ON "ingestion"."repository_binding_heads";
CREATE TRIGGER "repository_binding_heads_exclusive_main"
  BEFORE INSERT OR UPDATE OF "role", "workspace_id", "provider", "provider_repository_id"
  ON "ingestion"."repository_binding_heads"
  FOR EACH ROW
  EXECUTE FUNCTION "ingestion"."repository_binding_heads_guard_exclusive_main"();
