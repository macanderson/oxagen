CREATE TABLE "billing"."org_billing_profiles" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"org_id" uuid NOT NULL,
	"billing_email" "citext",
	"address_line1" text,
	"address_line2" text,
	"address_city" text,
	"address_region" text,
	"address_postal_code" text,
	"address_country" text,
	"address_place_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD COLUMN "type" text DEFAULT 'business' NOT NULL;--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD COLUMN "employee_size" text;--> statement-breakpoint
ALTER TABLE "billing"."org_billing_profiles" ADD CONSTRAINT "org_billing_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_billing_profiles_org_idx" ON "billing"."org_billing_profiles" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD CONSTRAINT "organizations_type_check" CHECK ("org"."organizations"."type" IN ('personal','business'));--> statement-breakpoint
ALTER TABLE "org"."organizations" ADD CONSTRAINT "organizations_employee_size_check" CHECK ("org"."organizations"."employee_size" IS NULL OR "org"."organizations"."employee_size" IN ('1','2-10','11-50','51-200','201-500','501-1000','1001-5000','5001-10000','10000+'));