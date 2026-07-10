-- auth.workspace_user_preferences.default_agent_id — the calling user's
-- preferred default agent for coding/chat tasks in this workspace.
--
-- Stored as the agents.public_id (agt_…). NULL = no default → the app falls
-- back to its built-in agent selection. Not an FK: agents live in the agent
-- schema and can be soft-deleted, so — like default_repo_connection_id and
-- default_environment_id on this table — the app resolves + validates the
-- agent at read time (no cross-schema FK per CLAUDE.md storage rules).
--
-- Additive + idempotent: absent rows ⇒ no default agent; a re-run is a no-op
-- (parallel-session safe).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth'
      AND table_name = 'workspace_user_preferences'
      AND column_name = 'default_agent_id'
  ) THEN
    ALTER TABLE "auth"."workspace_user_preferences" ADD COLUMN "default_agent_id" text;
  END IF;
END $$;

COMMENT ON COLUMN "auth"."workspace_user_preferences"."default_agent_id" IS
  'Nullable. The user''s preferred default agent for this workspace, stored as agents.public_id (agt_…). NULL = no default; the app resolves + validates the agent at read time (not an FK — agents are in another schema and soft-deletable).';
