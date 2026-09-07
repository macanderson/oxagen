-- Drop the stored image/video model defaults — ADR-041 follow-up.
--
-- ADR-041 removed media generation from the platform: there are no `image.*`
-- or `video.generate` capabilities, no media tiers in @oxagen/ai, and nothing
-- left that could consume a stored image or video model id. The two columns on
-- each of `workspace.workspaces` and `auth.user_preferences` are the last
-- residue of that surface — they are written by nothing and read by nothing.
--
-- This is a CONTRACT migration: every reader and writer of these columns was
-- removed in the same body of work (the `get_model_settings` /
-- `update_model_settings` and `get_user_preferences` /
-- `update_user_preferences` contracts, their handlers, the MCP tool schemas,
-- the account-preferences and workspace agent-defaults forms, and the
-- @oxagen/ai model-default resolver). Recovery is from git history plus a
-- restore.
--
-- Idempotent: IF EXISTS on every drop.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. workspace.workspaces — workspace-level media model defaults
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE "workspace"."workspaces"
  DROP COLUMN IF EXISTS "default_image_model";

ALTER TABLE "workspace"."workspaces"
  DROP COLUMN IF EXISTS "default_video_model";

-- ════════════════════════════════════════════════════════════════════════════
-- 2. auth.user_preferences — user-level media model defaults
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE "auth"."user_preferences"
  DROP COLUMN IF EXISTS "default_image_model";

ALTER TABLE "auth"."user_preferences"
  DROP COLUMN IF EXISTS "default_video_model";
