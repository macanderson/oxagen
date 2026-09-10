-- ADR-053: the organisation's own model-vendor API key.
--
-- While a live row exists, every completion the in-app agent makes for the
-- organisation runs on the customer's key and the customer's vendor invoice,
-- and Oxagen bills nothing for those tokens. With no row the platform key pays
-- and the tokens are billed as assistant usage. One live row per organisation.
--
-- Same shape as org.data_planes (20260907130000): id, audit and soft-delete
-- mixins, a same-schema FK to org.organizations, the KMS envelope as
-- ciphertext + key id + digest, and the org_only RLS class. Two differences:
-- the envelope is NOT NULL because a credential row with no key is not a state
-- the resolver can act on, and reads go through withTenantDb because nothing
-- resolves through this table — RLS is the filter, not a backstop.
--
-- key_hint is the last four characters of the key, for the settings page. It
-- is what a vendor dashboard shows and is not secret; the CHECK holds it to
-- four so a bug cannot widen it into the key itself.

CREATE TABLE "org"."model_credentials" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL)
      THEN public.uuid_generate_v7() ELSE public.uuid_generate_v4() END,
    public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "key_ciphertext" bytea NOT NULL,
  "key_key_id" text NOT NULL,
  "key_digest" text NOT NULL,
  "key_hint" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "last_verified_at" timestamptz NULL,
  "rotated_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "model_credentials_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "model_credentials_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "model_credentials_provider_check"
    CHECK ("provider" IN ('openrouter','gateway')),
  CONSTRAINT "model_credentials_status_check"
    CHECK ("status" IN ('active','disabled')),
  CONSTRAINT "model_credentials_key_hint_check"
    CHECK (length("key_hint") <= 4)
);

-- One LIVE credential per organisation. Partial on deleted_at so a revoked key
-- stays readable as history without blocking a new one.
CREATE UNIQUE INDEX "model_credentials_org_idx"
  ON "org"."model_credentials" ("org_id") WHERE ("deleted_at" IS NULL);

-- RLS: org_only. Byte-identical to what tools/scripts/gen-rls-migration.ts
-- emits for { table: "org.model_credentials", policyClass: "org_only" }.
ALTER TABLE org.model_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.model_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.model_credentials;
CREATE POLICY tenant_isolation ON org.model_credentials
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- Grants are idempotent and role-guarded: `drizzle-kit export` drops both
-- grants and policies on a rebaseline, and a fresh database has no app role yet.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON org.model_credentials TO oxagen_app';
  END IF;
END $$;
