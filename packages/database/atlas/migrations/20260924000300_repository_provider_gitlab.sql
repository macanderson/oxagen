-- GitLab as a second repository host for steering (#3762).
--
-- A Context PR records which host issued its number. A GitHub pull request
-- number and a GitLab merge request IID are both scoped to one repository, so
-- a number read back through the other host would name a different object.
-- Every Context PR opened before this migration was opened on GitHub.
ALTER TABLE agent.context_proposals ADD COLUMN provider text;
UPDATE agent.context_proposals SET provider = 'github' WHERE pr_number IS NOT NULL;
ALTER TABLE agent.context_proposals ADD CONSTRAINT context_proposals_provider_check
  CHECK (provider IS NULL OR provider IN ('github', 'gitlab'));
ALTER TABLE agent.context_proposals ADD CONSTRAINT context_proposals_pr_provider_check
  CHECK (pr_number IS NULL OR provider IS NOT NULL);

-- Bindings and heads name a host. `provider_repository_id` is unique only
-- within one host, so the provider must be one the product knows. Every row
-- written so far is 'github'.
ALTER TABLE ingestion.repository_bindings ADD CONSTRAINT repository_bindings_provider_check
  CHECK (provider IN ('github', 'gitlab'));
ALTER TABLE ingestion.repository_binding_heads ADD CONSTRAINT repository_binding_heads_provider_check
  CHECK (provider IN ('github', 'gitlab'));
