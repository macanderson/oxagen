-- Drop the onboarding gate's provisional window (#4616).
--
-- `provisional_until` held the end of the 14-day window a new organization
-- had to bind a main repository in. `openOnboardingGate` wrote it when the
-- gate row opened. `main_repo_bound_at` recorded the bind that closed the
-- window, and `bind_main_repository` was its only writer.
--
-- #4616 removes `bind_main_repository`. The steering repo job binds a
-- workspace's steering repository when the workspace is created (ADR-212), so
-- no window is left to close. `get_onboarding_state` was the last reader of
-- both columns, and it no longer answers a provisional window. No code reads
-- or writes either column after this change.
--
-- `detected_repository` stays. `enroll_host` still records there the
-- repository the enrolling host's git remote names.

ALTER TABLE "org"."onboarding_state" DROP COLUMN "provisional_until";
ALTER TABLE "org"."onboarding_state" DROP COLUMN "main_repo_bound_at";
