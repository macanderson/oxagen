CREATE TABLE "content"."generated_assets" (
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
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by_user_id" uuid,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"access_policy" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_url" text,
	"mime_type" text NOT NULL,
	"size_bytes" bigint,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "generated_assets_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "generated_assets_kind_check" CHECK ("content"."generated_assets"."kind" IN ('image', 'video')),
	CONSTRAINT "generated_assets_access_policy_check" CHECK ("content"."generated_assets"."access_policy" IN ('user', 'org', 'public')),
	CONSTRAINT "generated_assets_status_check" CHECK ("content"."generated_assets"."status" IN ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "generated_assets_org_idx" ON "content"."generated_assets" USING btree ("org_id","workspace_id");--> statement-breakpoint
CREATE INDEX "generated_assets_user_idx" ON "content"."generated_assets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generated_assets_conversation_idx" ON "content"."generated_assets" USING btree ("conversation_id");