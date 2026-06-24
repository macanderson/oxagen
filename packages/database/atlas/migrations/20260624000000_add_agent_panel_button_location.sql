-- Add agent_panel_button_location enum and column to user_preferences table
CREATE TYPE "auth"."agent_panel_button_location" AS ENUM ('lower-right', 'topnav', 'sidebar', 'command-palette-only');

ALTER TABLE "auth"."user_preferences" ADD COLUMN "agent_panel_button_location" "auth"."agent_panel_button_location" NOT NULL DEFAULT 'lower-right';
