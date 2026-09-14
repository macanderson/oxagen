-- ADR-057 (G2956): agent identity, the definition of record, budgets in micros.
--
-- Hand-written from the drizzle schema (packages/database/src/schema/agent.ts)
-- and reviewed; the statements below are this change's only.
--
--   1. agent.agents gains `harness`: the identity half of an agent records the
--      harness it runs under (MC spec §6.2) so the identities table prints it
--      for an agent that has no enrolled host. Existing rows are backfilled
--      with 'custom', the value `create_agent_def` implied.
--   2. agent.agent_versions gains the definition-of-record cache: the file
--      `.oxagen/agents/<slug>.toml` is the definition (ADR-057 decision 1),
--      and a version `commit_agent_definition` writes records the path, the
--      digest of the file at the commit, the file's text, the commit, the
--      branch and the pull request that carries it. Every column is nullable:
--      versions inserted by the legacy `create/update_agent_def` path carry
--      none of them.
--
-- billing.spend_budgets needs no change: `limit_micros bigint` has held the
-- ceiling in micro-USD since the table was created, and ADR-057 decision 2
-- changes the contract shape (`get_spend_budget` / `set_spend_budget` carry
-- Money), not the column.

-- ── 1. The harness on the identity row ──────────────────────────────────────
ALTER TABLE "agent"."agents"
  ADD COLUMN "harness" text NOT NULL DEFAULT 'custom';

ALTER TABLE "agent"."agents"
  ADD CONSTRAINT "agents_harness_check"
  CHECK ("harness" IN ('stella', 'claude-code', 'claude-agent-sdk', 'custom'));

COMMENT ON COLUMN "agent"."agents"."harness" IS
  'The harness the agent runs under (MC spec §6.2): stella, claude-code, claude-agent-sdk or custom.';

-- ── 2. The definition-of-record cache on the version row ────────────────────
ALTER TABLE "agent"."agent_versions"
  ADD COLUMN "definition_path" text NULL,
  ADD COLUMN "definition_digest" text NULL,
  ADD COLUMN "definition_source" text NULL,
  ADD COLUMN "commit_sha" text NULL,
  ADD COLUMN "branch" text NULL,
  ADD COLUMN "pull_request_url" text NULL;

COMMENT ON COLUMN "agent"."agent_versions"."definition_path" IS
  'Path of the definition of record in the workspace repository (.oxagen/agents/<slug>.toml). Null on versions the legacy definition path inserted.';
COMMENT ON COLUMN "agent"."agent_versions"."definition_digest" IS
  'sha256 hex of the definition file at commit_sha; a run records it as the agent version it ran from.';
COMMENT ON COLUMN "agent"."agent_versions"."definition_source" IS
  'The definition file text at commit_sha, cached so the definition reads without a GitHub round trip.';
COMMENT ON COLUMN "agent"."agent_versions"."commit_sha" IS
  'The commit that wrote definition_path on branch.';
COMMENT ON COLUMN "agent"."agent_versions"."branch" IS
  'The branch the definition was committed to; never the repository default branch.';
COMMENT ON COLUMN "agent"."agent_versions"."pull_request_url" IS
  'The pull request opened for branch; merging it publishes the definition.';
