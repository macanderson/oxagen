-- ADR-131: the OpenRouter key Oxagen mints for one organisation.
--
-- Not the same thing as org.model_credentials (ADR-053), and the difference is
-- who pays. A model_credentials row is a key the CUSTOMER brought: their
-- vendor invoice, and Oxagen bills nothing for those tokens. A row here is a
-- key OXAGEN minted on its own OpenRouter account and handed to one
-- organisation: Oxagen's invoice, and the tokens are metered and billed as
-- assistant usage exactly as they were on the single shared key this table
-- replaces. Funding is unchanged by this table; only WHICH key spends is.
--
-- Why per-organisation rather than one key for everyone:
--   * a runaway turn hits daily_limit_usd and stops, instead of draining the
--     account ceiling that every other customer's assistant depends on;
--   * OpenRouter reports usage per key, so an invoice line has a per-customer
--     ground truth that does not come from Oxagen's own meter — the number an
--     auditor asks for and the one a billing dispute is settled with;
--   * one customer can be cut off (status='disabled') without touching anyone
--     else's assistant.
--
-- One row per organisation, forever: org_id is UNIQUE with no soft-delete
-- predicate, because a rotation UPDATES the row rather than adding one. The
-- vendor's key_hash is the durable identity and key_name is a label people
-- read (see assistantKeyName); neither is ever rewritten after the insert, so
-- a renamed organisation's old invoices stay readable backwards.
--
-- The envelope is the same shape as org.model_credentials and org.data_planes:
-- ciphertext + key id + digest, opened only by the resolver beside them. It is
-- NOT NULL because a row with no key is not a state the resolver can act on.
-- key_hint is the last four characters, held to four by a CHECK so a bug
-- cannot widen it into the key itself.

CREATE TABLE "org"."assistant_model_keys" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL)
      THEN public.uuid_generate_v7() ELSE public.uuid_generate_v4() END,
    public.uuid_generate_v4()),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid NULL,
  "updated_by_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "provider" text NOT NULL DEFAULT 'openrouter',
  -- The vendor's durable handle. Every later call (raise the ceiling, disable,
  -- read usage, delete) is addressed by it, and it is what an OpenRouter usage
  -- export joins to this organisation. Not a secret.
  "key_hash" text NOT NULL,
  -- The display name, fixed at creation: oxagen/<slug-at-creation>/<creator email>.
  -- Never rewritten — see the module comment on assistantKeyName.
  "key_name" text NOT NULL,
  "key_ciphertext" bytea NOT NULL,
  "key_key_id" text NOT NULL,
  "key_digest" text NOT NULL,
  "key_hint" text NOT NULL,
  -- The ceiling OpenRouter refills every midnight UTC, in USD. Stored as well
  -- as sent so a drift check can ask the vendor what it thinks the ceiling is
  -- and compare, rather than assuming the PATCH that set it landed.
  "daily_limit_usd" numeric(10, 2) NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "provisioned_at" timestamptz NOT NULL DEFAULT now(),
  "disabled_at" timestamptz NULL,
  -- Why the last provisioning attempt failed, for an operator reading a row
  -- that exists but cannot serve. Never carries key material: the writer
  -- scrubs the vendor's text first.
  "last_error" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_model_keys_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "assistant_model_keys_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  -- One key per organisation. This is the idempotence the provisioner relies
  -- on: two concurrent org-creation callbacks race here, the loser sees a
  -- unique violation and deletes the key it had just minted at the vendor.
  CONSTRAINT "assistant_model_keys_org_unique" UNIQUE ("org_id"),
  -- A hash identifies one vendor key; two organisations sharing one would make
  -- every usage figure ambiguous, which is the whole point of the table.
  CONSTRAINT "assistant_model_keys_hash_unique" UNIQUE ("key_hash"),
  CONSTRAINT "assistant_model_keys_provider_check"
    CHECK ("provider" IN ('openrouter')),
  CONSTRAINT "assistant_model_keys_status_check"
    CHECK ("status" IN ('active','disabled')),
  CONSTRAINT "assistant_model_keys_key_hint_check"
    CHECK (length("key_hint") <= 4),
  -- A zero or negative ceiling is not a smaller ceiling, it is a key that can
  -- never answer. An operator who wants that sets status='disabled'.
  CONSTRAINT "assistant_model_keys_daily_limit_check"
    CHECK ("daily_limit_usd" > 0),
  -- status and disabled_at agree in both directions, so "is this key off?"
  -- has one answer however it is asked.
  CONSTRAINT "assistant_model_keys_disabled_pairing_check"
    CHECK (("status" = 'disabled') = ("disabled_at" IS NOT NULL))
);

-- RLS: org_only. Byte-identical to what tools/scripts/gen-rls-migration.ts
-- emits for { table: "org.assistant_model_keys", policyClass: "org_only" }.
ALTER TABLE org.assistant_model_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.assistant_model_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.assistant_model_keys;
CREATE POLICY tenant_isolation ON org.assistant_model_keys
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- Grants are idempotent and role-guarded: `drizzle-kit export` drops both
-- grants and policies on a rebaseline, and a fresh database has no app role yet.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON org.assistant_model_keys TO oxagen_app';
  END IF;
END $$;
