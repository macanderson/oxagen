CREATE TABLE "billing"."billing_disputes" (
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
	"stripe_dispute_id" text NOT NULL,
	"stripe_charge_id" text,
	"payment_intent_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"reason" text,
	"status" text NOT NULL,
	"clawed_back_cents" bigint DEFAULT 0 NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "billing_disputes_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "billing"."org_billing_settings" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"org_id" uuid NOT NULL,
	"auto_reload_enabled" boolean DEFAULT false NOT NULL,
	"auto_reload_threshold_cents" bigint DEFAULT 500 NOT NULL,
	"auto_reload_amount_cents" bigint DEFAULT 2000 NOT NULL,
	"auto_reload_payment_method_id" text,
	"last_auto_reload_at" timestamp with time zone,
	"low_balance_threshold_cents" bigint DEFAULT 500 NOT NULL,
	"dunning_state" text DEFAULT 'active' NOT NULL,
	"delinquent_since" timestamp with time zone,
	"grace_ends_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"last_dunning_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	CONSTRAINT "org_billing_settings_dunning_state_check" CHECK ("billing"."org_billing_settings"."dunning_state" IN ('active','grace','suspended'))
);
--> statement-breakpoint
ALTER TABLE "billing"."billing_disputes" ADD CONSTRAINT "billing_disputes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."org_billing_settings" ADD CONSTRAINT "org_billing_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_disputes_stripe_dispute_idx" ON "billing"."billing_disputes" USING btree ("stripe_dispute_id");--> statement-breakpoint
CREATE INDEX "billing_disputes_org_idx" ON "billing"."billing_disputes" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "org_billing_settings_org_idx" ON "billing"."org_billing_settings" USING btree ("org_id");