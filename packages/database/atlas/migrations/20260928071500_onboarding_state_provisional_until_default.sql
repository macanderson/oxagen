-- Give `provisional_until` a default (#4616, #4647).
--
-- #4616 removes `bind_main_repository` and the provisional window it closed.
-- `openOnboardingGate` no longer writes `provisional_until`, and nothing
-- reads it or `main_repo_bound_at`. The columns stay for one release:
-- `migration-gate` applies this file before `deploy-node` replaces the
-- running nodes, and those nodes still select both columns in
-- `get_onboarding_state` and still write `provisional_until`.
--
-- The column is NOT NULL, so a row the new code inserts needs a default.
-- Fourteen days matches the value the old code wrote, so an old node reads
-- the same window it would have written. #4667 drops both columns once no
-- node on the old release is serving.

ALTER TABLE "org"."onboarding_state"
  ALTER COLUMN "provisional_until" SET DEFAULT (now() + interval '14 days');
