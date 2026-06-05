-- 0004_user_preferences.sql
--
-- Adds the user/workspace preferences schema spine.
--
-- Changes:
--   1. Four enum types in the auth schema: font_size, density,
--      pending_prompt_behavior, model_tier (shared with workspace).
--   2. auth.user_preferences — 1:1 with auth.users (UNIQUE on user_id),
--      FK → auth.users.id ON DELETE CASCADE.
--   3. Four nullable model-default columns on workspace.workspaces
--      (additive; no table rewrite).
--
-- Forward-only, expand-only, additive. No destructive operations.

CREATE TYPE "auth"."density" AS ENUM('compact', 'comfortable', 'spacious');
--> statement-breakpoint
CREATE TYPE "auth"."font_size" AS ENUM('small', 'medium', 'large');
--> statement-breakpoint
CREATE TYPE "auth"."model_tier" AS ENUM('fast', 'balanced', 'precise');
--> statement-breakpoint
CREATE TYPE "auth"."pending_prompt_behavior" AS ENUM('queue', 'interrupt');
--> statement-breakpoint
CREATE TABLE "auth"."user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	"user_id" uuid NOT NULL,
	"font_size" "auth"."font_size" DEFAULT 'medium' NOT NULL,
	"density" "auth"."density" DEFAULT 'comfortable' NOT NULL,
	"enter_to_submit" boolean DEFAULT false NOT NULL,
	"pending_prompt_behavior" "auth"."pending_prompt_behavior" DEFAULT 'queue' NOT NULL,
	"default_text_tier" "auth"."model_tier",
	"default_text_model" text,
	"default_image_model" text,
	"default_video_model" text,
	CONSTRAINT "user_preferences_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "workspace"."workspaces" ADD COLUMN "default_text_tier" "auth"."model_tier";
--> statement-breakpoint
ALTER TABLE "workspace"."workspaces" ADD COLUMN "default_text_model" text;
--> statement-breakpoint
ALTER TABLE "workspace"."workspaces" ADD COLUMN "default_image_model" text;
--> statement-breakpoint
ALTER TABLE "workspace"."workspaces" ADD COLUMN "default_video_model" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_user_id_idx" ON "auth"."user_preferences" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "auth"."user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;
