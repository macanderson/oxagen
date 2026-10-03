-- Any workspace may link any repository its GitHub App installation can see
-- (ADR-293, #5355).
--
-- Mac decided this on 2026-10-03. Many workspaces may link one repository,
-- and that includes a repository another workspace uses as its steering
-- repository. One rule stays: an agent is steered by one steering
-- repository. The workspace picks it, and every run names its workspace.
--
-- The trigger repository_binding_heads_exclusive_main
-- (20260918200000, narrowed to `steering` by 20260927185600) refused two
-- writes that are now allowed:
--
--   - a linked head where another workspace holds the repository as its
--     steering repository (repository_binding_heads_linked_is_main_elsewhere)
--   - a steering head where another workspace links the repository
--     (repository_binding_heads_main_is_linked_elsewhere)
--
-- The trigger's third refusal was a second steering head for one repository.
-- The partial unique index repository_binding_heads_main_repository_uq
-- refuses that on its own, under the same name. A unique index also makes a
-- concurrent insert of the same key wait for the first one to commit, so a
-- race ends in the same 23505. With nothing left for it to do, this file
-- drops the trigger, then its function.
--
-- Kept on purpose:
--
--   - repository_binding_heads_main_repository_uq. No two workspaces are
--     steered by one repository.
--   - repository_binding_heads_workspace_steering_uq. A workspace has one
--     steering repository.
--   - repository_binding_heads_repository_idx. It was built for the
--     trigger's lookup. The code repository check and create_github_token
--     read every head for one repository by the same two columns across
--     workspaces (lib/repository-heads-anywhere.ts), and no other index
--     serves that read.
--
-- No row changes. Every head the trigger admitted is still allowed.

DROP TRIGGER IF EXISTS "repository_binding_heads_exclusive_main"
  ON "ingestion"."repository_binding_heads";

DROP FUNCTION IF EXISTS "ingestion"."repository_binding_heads_guard_exclusive_main"();
