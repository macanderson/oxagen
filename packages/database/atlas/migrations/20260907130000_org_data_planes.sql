-- ADR-042 — organisation-scoped data planes.
--
-- One row per (organisation, store kind) binding that organisation's traces,
-- graph, and evidence to a physical endpoint. ABSENCE of a row means the
-- shared platform plane, so this table is sparse by design and a fresh
-- deployment has none at all — the resolver in @oxagen/database treats "no
-- row" and "mode = shared" identically.
--
--   kind    postgres | neo4j | clickhouse — the three stores of the four-store
--           model that carry tenant data. Blob storage is out of scope for this
--           slice.
--   mode    shared    the platform plane; every config column stays NULL.
--           dedicated a customer-controlled endpoint; the config columns are
--                     required (see data_planes_config_pairing_check).
--   status  active | degraded | disabled. Only `active` admits traffic: a
--           degraded (schema behind the platform) or disabled plane makes the
--           organisation's scoped store access fail closed with
--           DataPlaneUnavailableError rather than silently falling back to the
--           shared plane — that fallback would write tenant data into the very
--           store the customer moved it out of.
--
-- config_ciphertext is the @oxagen/crypto KMS envelope (version byte + iv +
-- wrapped DEK + AES-256-GCM ciphertext) over the JSON connection config —
-- exactly the envelope the plugin credential vault uses. The plaintext DSN
-- never exists in a column, a log line, or a read capability's output;
-- get_data_plane returns host + database name only. config_key_id records the
-- KEK that wrapped the DEK so a rotation can route the decrypt, and
-- config_digest is a SHA-256 over the canonical plaintext config: it is the
-- pool/cache key the store clients evict on, so a rotated credential produces
-- a new key instead of reusing a pool bound to a revoked password.
--
-- The org schema already exists; no CREATE SCHEMA needed. Same-schema FK to
-- org.organizations (no cross-domain FK, per CLAUDE.md). Plain DDL only
-- (RDS-compatible). RLS mirrors the org_only class emitted by
-- tools/scripts/gen-rls-migration.ts from POLICY_MANIFEST.

CREATE TABLE "org"."data_planes" (
  "id" uuid NOT NULL DEFAULT COALESCE(
    CASE
      WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
      ELSE public.uuid_generate_v4()
    END,
    public.uuid_generate_v4()
  ),
  "public_id" public.citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_user_id" uuid NULL,
  "updated_by_user_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_user_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'shared',
  -- KMS envelope over the JSON connection config. NEVER plaintext.
  "config_ciphertext" bytea NULL,
  "config_key_id" text NULL,
  "config_digest" text NULL,
  "status" text NOT NULL DEFAULT 'active',
  "schema_version" text NULL,
  "last_verified_at" timestamptz NULL,
  "rotated_at" timestamptz NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "data_planes_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "data_planes_org_id_organizations_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id"),
  CONSTRAINT "data_planes_kind_check" CHECK (kind IN ('postgres', 'neo4j', 'clickhouse')),
  CONSTRAINT "data_planes_mode_check" CHECK (mode IN ('shared', 'dedicated')),
  CONSTRAINT "data_planes_status_check" CHECK (status IN ('active', 'degraded', 'disabled')),
  -- A dedicated plane is unusable without its envelope; a shared plane must not
  -- carry one. Enforcing the pairing here means a partial write can never
  -- produce a row the resolver has to guess about.
  CONSTRAINT "data_planes_config_pairing_check" CHECK (
    (mode = 'shared' AND config_ciphertext IS NULL AND config_key_id IS NULL)
    OR (mode = 'dedicated' AND config_ciphertext IS NOT NULL AND config_key_id IS NOT NULL)
  )
);

-- One LIVE binding per (organisation, store). Partial on deleted_at so a
-- retired binding stays readable as history without blocking a new one. This
-- index is also the resolver's lookup path (org_id, kind).
CREATE UNIQUE INDEX "data_planes_org_kind_idx"
  ON "org"."data_planes" ("org_id", "kind")
  WHERE ("deleted_at" IS NULL);

-- ── RLS — tenant_isolation (org_only class) ──────────────────────────────────
-- Byte-identical to what tools/scripts/gen-rls-migration.ts emits for
-- { table: "org.data_planes", policyClass: "org_only" }.
ALTER TABLE org.data_planes ENABLE ROW LEVEL SECURITY;
ALTER TABLE org.data_planes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON org.data_planes;
CREATE POLICY tenant_isolation ON org.data_planes
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- ── oxagen_app grants ────────────────────────────────────────────────────────
-- A binding is mutable operational state (rotation, status flips, soft delete),
-- so the app role gets the full CRUD set like every other org-scoped settings
-- table. Idempotent + role-guarded (schema-level grants preexist).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON org.data_planes TO oxagen_app';
  END IF;
END
$$;
