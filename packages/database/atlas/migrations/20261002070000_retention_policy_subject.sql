-- evidence.retention_policy_versions records whose policy each row is
-- (ADR-235).
--
-- The in-app assistant pins a retention policy on every run it admits. It
-- read the workspace's newest row, or wrote version 1 when the workspace had
-- none. So the first assistant turn in a workspace wrote the workspace's
-- policy, and every workspace reader read that row as the workspace's own:
-- readLatestRetentionPolicy (run seal, Tacho idle close, findings prompts),
-- readWorkspaceRetention (the Tacho bundle), and get_evidence_retention (the
-- org Audit page). The maintainer ruled that the assistant keeps its own
-- policy row. Each row now names a subject: 'workspace' or 'oxagen_assistant'.
-- Workspace readers filter on 'workspace'. The assistant reads and writes
-- only 'oxagen_assistant'.
--
-- Both unique indexes gain the subject, so a workspace's version 1 and the
-- assistant's version 1 can coexist. Each keeps its name.
--
-- The backfill moves every row the assistant wrote to its own subject. No
-- other production code writes this table. policy_digest is the RFC 8785
-- digest of the policy body (digestJcs in @oxagen/run-evidence), and the
-- assistant wrote one of two bodies:
--
--   sha256:bd1d48b3dc0b6d124d2af405ee5abef94f1f72d68ef385935b212f63d36a08e6
--     {"mode":"content_exact","retained_content_classes":["admission_receipt",
--     "checkout_receipt","context_selection","model_call","tool_call",
--     "approval_receipt","change_receipt","verification_receipt",
--     "provider_receipt","terminal_receipt"],"ttl_days":2555}
--     The body since 522fec3065 (#2997). RETENTION_CONTENT_CLASSES has not
--     changed since 9227d322f7 (#1111), so every such row has this digest.
--
--   sha256:b77553c25e38fae09c720ecfb66e1d11ee1035530b42d64e46a80f85fcb715ba
--     {"mode":"digest_only","retained_content_classes":[],"ttl_days":30}
--     The body the assistant wrote on the app-rebuild branch (9aa2f46e3f,
--     92d92133a6) until #3055 changed it. That body never reached main, so
--     this arm matches only a database an app-rebuild build wrote to.
--
-- A workspace left with no 'workspace' row reads the retain-all default,
-- which is what the content_exact row already said. A workspace that held
-- the digest_only row stops reading it as its own policy.
--
-- The table forces row-level security and the migration role sets no tenant,
-- so the backfill sets app.rls_bypass for its one statement, as
-- 20260926020000 does.

ALTER TABLE "evidence"."retention_policy_versions"
  ADD COLUMN "subject" text NOT NULL DEFAULT 'workspace',
  ADD CONSTRAINT "retention_policy_versions_subject_check"
    CHECK (subject IN ('workspace', 'oxagen_assistant'));

COMMENT ON COLUMN "evidence"."retention_policy_versions"."subject" IS
  'Whose policy the row is: workspace, or oxagen_assistant for the in-app assistant''s own runs (ADR-235). Workspace readers filter on workspace.';

DROP INDEX "evidence"."retention_policy_versions_version_uniq";
CREATE UNIQUE INDEX "retention_policy_versions_version_uniq"
  ON "evidence"."retention_policy_versions" ("org_id", "workspace_id", "subject", "version");

DROP INDEX "evidence"."retention_policy_versions_digest_uniq";
CREATE UNIQUE INDEX "retention_policy_versions_digest_uniq"
  ON "evidence"."retention_policy_versions" ("org_id", "workspace_id", "subject", "policy_digest");

SELECT set_config('app.rls_bypass', 'on', true);

UPDATE "evidence"."retention_policy_versions"
SET subject = 'oxagen_assistant'
WHERE subject = 'workspace'
  AND policy_digest IN (
    'sha256:bd1d48b3dc0b6d124d2af405ee5abef94f1f72d68ef385935b212f63d36a08e6',
    'sha256:b77553c25e38fae09c720ecfb66e1d11ee1035530b42d64e46a80f85fcb715ba'
  );

SELECT set_config('app.rls_bypass', '', true);
