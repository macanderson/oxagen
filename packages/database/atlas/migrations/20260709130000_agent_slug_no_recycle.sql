-- Agent slugs — and therefore agentKeys — are PERMANENTLY non-recyclable, like
-- npm package names. Once a workspace has used a slug, it is reserved forever:
-- soft-deleting the agent must NOT free the slug for a new agent to claim, or
-- the same org_ns.workspace_ns.slug key could resolve to two different agents
-- over time, breaking the permanent-global-identity guarantee (ADR-024).
--
-- The original uniqueness index `agents_workspace_slug_uniq` was PARTIAL
-- (WHERE deleted_at IS NULL), so a soft delete dropped the row out of the index
-- and freed the slug. This migration replaces it with a NON-partial UNIQUE index
-- covering soft-deleted rows too, so a slug can never be re-inserted once used.
--
-- Safety: verified before writing that ZERO duplicate (workspace_id, slug) pairs
-- exist across ALL rows (including soft-deleted) — so the non-partial unique
-- index builds cleanly and no dedup trigger is needed. (Had duplicates existed,
-- the alternative was to keep the partial index and add a BEFORE INSERT trigger
-- rejecting any slug that matches a soft-deleted agent in the same workspace.)
--
-- Note on soft-delete semantics: soft delete sets deleted_at on the SAME row
-- (it never inserts a second row), so each (workspace_id, slug) has exactly one
-- row for all time. The non-partial index simply forbids ever inserting a
-- second row with a slug the workspace has already spent.

DROP INDEX IF EXISTS "agent"."agents_workspace_slug_uniq";

CREATE UNIQUE INDEX "agents_workspace_slug_uniq"
  ON "agent"."agents" ("workspace_id", "slug");
