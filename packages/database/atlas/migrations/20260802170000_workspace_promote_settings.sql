-- Promote `description` and `promptConfig` out of workspace.workspaces.settings
-- (JSONB bag) into dedicated columns (2026-07-11 audit §1.7).
--
-- Before: workspace.settings.write merged `description` and prompt.settings.write
-- merged `promptConfig`, both via read-whole-settings → merge-in-JS →
-- write-whole-settings with no row lock. Concurrent writes silently clobbered
-- each other's key (lost update). Splitting them into disjoint columns means the
-- two handlers touch different columns and can no longer collide; prompt.settings
-- .write additionally merges its column atomically via jsonb `||`.

-- 1. Add the columns. prompt_config mirrors the settings default ('{}').
ALTER TABLE "workspace"."workspaces"
  ADD COLUMN IF NOT EXISTS "description" text;
ALTER TABLE "workspace"."workspaces"
  ADD COLUMN IF NOT EXISTS "prompt_config" jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Backfill from the existing settings bag.
UPDATE "workspace"."workspaces"
SET "description" = "settings"->>'description'
WHERE "settings" ? 'description'
  AND jsonb_typeof("settings"->'description') = 'string';

UPDATE "workspace"."workspaces"
SET "prompt_config" = "settings"->'promptConfig'
WHERE "settings" ? 'promptConfig'
  AND jsonb_typeof("settings"->'promptConfig') = 'object';

-- 3. Remove the promoted keys from the bag so it is no longer a second source of
--    truth (other settings keys — model settings, plugin auth alerts — remain).
UPDATE "workspace"."workspaces"
SET "settings" = "settings" - 'description' - 'promptConfig'
WHERE "settings" ? 'description' OR "settings" ? 'promptConfig';
