-- One repository is the MAIN repository of at most one workspace, anywhere.
--
-- ## Why this is a constraint and not a convention
--
-- `.oxagen/rules/` lives in the main repository and steering resolution reads
-- it through this table's head (packages/handlers/src/context.steering.github.ts).
-- The rule set is keyed by `set_id`, which is the repository's full name. Two
-- workspaces sharing a main repository therefore write their steering records
-- into the SAME files in the SAME git repository under the SAME key, and each
-- reads the other's records back as its own. Nothing errors; the governance of
-- one workspace silently becomes the governance of another.
--
-- The second hazard is attribution. A local checkout resolves to a workspace
-- through its repository, so a repository that is main for two workspaces makes
-- "which workspace does this run belong to — whose mandate, whose budget, whose
-- trace" unanswerable. That is the question the product exists to answer.
--
-- Mission Control spec §10.1 already states the rule ("exactly one per
-- workspace ... changing which repo is main is an org-owner action"). Until now
-- nothing enforced the direction that matters. `repository.main.bind.ts` takes
-- a `pg_advisory_xact_lock` keyed on the WORKSPACE and then reads that
-- workspace's heads, which answers "does this workspace already bind a
-- different repository" and cannot answer "is this repository already main
-- somewhere else" — the lock does not even serialise the two binds that would
-- race, because they take different workspace keys.
--
-- ## Why the index is global, with no org_id in the key
--
-- Scoping the uniqueness per organisation would still admit the case the rule
-- is mostly about: the same repository claimed as main by two different
-- organisations, which is how one tenant's steering reaches another's agents.
-- The key is therefore (provider, provider_repository_id) and nothing else.
--
-- `provider` is in the key because `provider_repository_id` is only unique
-- WITHIN a provider — GitHub and GitLab both issue small integers and they
-- collide numerically.
--
-- CAVEAT, stated because it is not visible from this file: a unique index is
-- global only within one Postgres. ADR-042 lets an organisation carry a
-- dedicated data plane, and ingestion is tenant data that such a plane would
-- hold, so this index cannot see a claim made on another plane. Every
-- organisation is shared today (ADR-042 §1 — absence of a row means shared, and
-- the dedicated mode has no customer), so it holds universally right now. The
-- handler refuses a dedicated-plane bind rather than pretending otherwise; the
-- real repair is a plane-aware seam, which is a change to the store client.
--
-- ## Why `role`, when v1 has no such concept
--
-- Today every head in a workspace is implicitly the main repository — the
-- handler admits at most one. The rule being encoded, though, is specifically
-- about MAIN repositories: a shared library legitimately belongs to several
-- workspaces as a LINKED repository, and v2 (`contracts/v2/link-repository.ts`,
-- inert until #2884's cutover) already defines `role: 'main' | 'linked'` for
-- exactly that. A bare unique index on (provider, provider_repository_id) would
-- encode the WRONG rule — "a repository belongs to one workspace, full stop" —
-- and would have to be dropped and rebuilt at cutover, at which point the first
-- legitimate linked repository would collide with a main one and block it.
--
-- So the column lands now and the index is partial on it. Correct today,
-- correct after the cutover, no second migration.
--
-- Backfilled to 'main' with no exception: every existing head IS the main
-- repository of its workspace by construction of the only writer.
ALTER TABLE "ingestion"."repository_binding_heads"
  ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'main';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'repository_binding_heads_role_check'
       AND conrelid = 'ingestion.repository_binding_heads'::regclass
  ) THEN
    ALTER TABLE "ingestion"."repository_binding_heads"
      ADD CONSTRAINT "repository_binding_heads_role_check"
      CHECK ("role" IN ('main', 'linked'));
  END IF;
END
$$;

-- ## Reconciling claims that already exist
--
-- The backfill above marks EVERY existing head 'main', because under the old
-- schema every head was one. Nothing before this migration forbade two
-- workspaces from binding the same repository, so rows the new index refuses
-- may already be in the table — and `CREATE UNIQUE INDEX` on data that
-- violates it aborts, taking the deploy with it. A constraint that cannot be
-- built is not a guard; it is an outage.
--
-- The repair is deterministic and keeps the OLDEST head 'main'. That head is
-- the claim every steering read resolved against up to now, so keeping it is
-- the choice that changes nothing about which workspace is currently steered;
-- picking any other would silently move one workspace's governance. Later
-- claims become 'linked', which is a real state with real meaning — the
-- workspace can still see the repository, it is simply no longer steered by
-- it — rather than a deletion. No head is removed, no binding is dropped, and
-- no connection is touched, so a workspace demoted here re-binds through
-- `repository.main.bind` and receives the product's own refusal explaining
-- that the repository is claimed elsewhere.
--
-- Each demotion is raised as a NOTICE so the deploy log names exactly which
-- workspaces were affected, rather than leaving the change to be discovered.
DO $$
DECLARE
  demoted record;
  n integer := 0;
BEGIN
  FOR demoted IN
    UPDATE "ingestion"."repository_binding_heads" AS h
       SET "role" = 'linked',
           "updated_at" = now()
     WHERE h."role" = 'main'
       AND EXISTS (
         SELECT 1
           FROM "ingestion"."repository_binding_heads" AS older
          WHERE older."role" = 'main'
            AND older."provider" = h."provider"
            AND older."provider_repository_id" = h."provider_repository_id"
            -- Strictly older wins; `id` breaks a tie on identical timestamps,
            -- which uuidv7 makes ordered by creation anyway. Without the tie
            -- break two rows written in the same instant would each find the
            -- other "older" and both would be demoted, leaving the repository
            -- main for nobody.
            AND (older."created_at", older."id") < (h."created_at", h."id")
       )
    RETURNING h."org_id", h."workspace_id", h."provider", h."provider_repository_id"
  LOOP
    n := n + 1;
    RAISE NOTICE
      'repository_binding_heads: demoted main -> linked for org % workspace % on %:% (repository already claimed by an older head)',
      demoted."org_id", demoted."workspace_id", demoted."provider", demoted."provider_repository_id";
  END LOOP;
  IF n > 0 THEN
    RAISE NOTICE 'repository_binding_heads: % duplicate main claim(s) reconciled before building the uniqueness guard', n;
  END IF;
END
$$;

-- The guard itself. Partial on role='main' so linked repositories stay
-- many-to-many, and deliberately carrying neither org_id nor workspace_id.
CREATE UNIQUE INDEX IF NOT EXISTS "repository_binding_heads_main_repository_uq"
  ON "ingestion"."repository_binding_heads" ("provider", "provider_repository_id")
  WHERE "role" = 'main';
