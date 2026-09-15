-- agent.agent_runs: a `general` run binds no repository.
--
-- RunSpecV2 admits two run kinds (packages/run-ledger/src/run-spec-v2.ts,
-- docs/specs/run-evidence-ingress/spec.md "run_kind = general | repo_edit").
-- A repo_edit run pins every repository field; a general run has none, and
-- buildCreateRunSql writes NULL into all seven repository columns for one.
-- agent_runs_v2_identity_check (20260813100000) required those seven columns
-- NOT NULL on every V2 row, so the first general run the ledger ever admitted
-- — the e2e seed's — failed the CHECK. No earlier caller had reached
-- createRun with a general spec.
--
-- The repository columns now follow run_kind: all seven NULL for a general
-- run, all seven NOT NULL for a repo_edit run. The remaining V2 columns stay
-- required on every V2 row and a V1 row is unchanged, so this is expand-only:
-- every row the old constraint admitted still passes.
--
-- Dropped and re-created rather than altered: Postgres has no ALTER for a
-- CHECK expression.
ALTER TABLE "agent"."agent_runs"
  DROP CONSTRAINT IF EXISTS "agent_runs_v2_identity_check";

ALTER TABLE "agent"."agent_runs"
  ADD CONSTRAINT "agent_runs_v2_identity_check" CHECK (
    (
      spec_version = 1
      AND run_kind IS NULL
      AND spec_digest IS NULL
      AND initiating_principal_id IS NULL
      AND agent_principal_id IS NULL
      AND agent_id IS NULL
      AND agent_version_id IS NULL
      AND agent_version_checksum IS NULL
      AND authorization_snapshot_id IS NULL
      AND repository_binding_id IS NULL
      AND repository_provider IS NULL
      AND provider_repository_id IS NULL
      AND repository_connection_id IS NULL
      AND configured_default_ref IS NULL
      AND base_commit_sha IS NULL
      AND base_tree_sha IS NULL
      AND retention_policy_id IS NULL
      AND retention_policy_digest IS NULL
      AND max_attempts IS NULL
    ) OR (
      spec_version = 2
      AND run_kind IS NOT NULL
      AND spec_digest IS NOT NULL
      AND initiating_principal_id IS NOT NULL
      AND agent_principal_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND agent_version_id IS NOT NULL
      AND agent_version_checksum IS NOT NULL
      AND authorization_snapshot_id IS NOT NULL
      AND retention_policy_id IS NOT NULL
      AND retention_policy_digest IS NOT NULL
      AND max_attempts IS NOT NULL
      AND (
        (
          run_kind = 'general'
          AND repository_binding_id IS NULL
          AND repository_provider IS NULL
          AND provider_repository_id IS NULL
          AND repository_connection_id IS NULL
          AND configured_default_ref IS NULL
          AND base_commit_sha IS NULL
          AND base_tree_sha IS NULL
        ) OR (
          run_kind = 'repo_edit'
          AND repository_binding_id IS NOT NULL
          AND repository_provider IS NOT NULL
          AND provider_repository_id IS NOT NULL
          AND repository_connection_id IS NOT NULL
          AND configured_default_ref IS NOT NULL
          AND base_commit_sha IS NOT NULL
          AND base_tree_sha IS NOT NULL
        )
      )
    )
  );
