-- The onboarding gate may open before the organization has a workspace
-- (#4582).
--
-- create_org used to make the first workspace itself, so the gate always had
-- one to name. The web app now sends `workspace: null`, and the welcome flow
-- asks you to name your first workspace on its own step. Until you do, the
-- organization's gate row carries no workspace. create_workspace fills
-- workspace_id on the first workspace it makes, and only while it is still
-- NULL.
--
-- Readers already handle a gate with no workspace: get_onboarding_state
-- left-joins the workspace, and advance_onboarding and the provisional check
-- in publish_context_record match `workspace_id = <id>`, which NULL never
-- satisfies. The RLS policy keys on org_id alone, so it is unchanged.

ALTER TABLE "org"."onboarding_state" ALTER COLUMN "workspace_id" DROP NOT NULL;
