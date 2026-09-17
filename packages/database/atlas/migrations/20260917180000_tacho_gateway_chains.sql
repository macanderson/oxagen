-- tacho.gateway_chains — which of a host's daemon chains the control plane has
-- served a gateway call for, and when it last did (#3221).
--
-- 20260917140000 gave the enforcement tier a server-owned foundation:
-- `hosts.gateway_last_seen_at`, stamped where Oxagen authenticates a
-- server-minted `tacho_gateway_v1` credential. That fixed *whether* a host had
-- served a gateway call. It could not fix *which session* had, because it is a
-- single timestamp with no session on it — so ingest still read
-- `oxagen.enforcement_tier` off the submitted batch to decide that half.
--
-- Whoever can submit a batch chooses that attribute. Once a host had served
-- one legitimate gateway call, a holder of its control-plane key could point
-- the observation at any session, including one invented in the same batch
-- (`genesisRow` passes no lifetime, so nothing predates it). The promotion is
-- monotonic and the replay grade is signed carrying it.
--
-- Each row here is the control plane's own record that it has served this
-- host's gateway on this chain. The chain id is named by the caller — but the
-- caller is authenticated as the holder of the gateway credential, which never
-- leaves the daemon, and a batch submitter cannot cause a row to exist at all.
--
-- ## What binds a row to a real chain
--
-- `chain_session_uuid` says WHICH chain and `chain_genesis_hash` says it is
-- that chain rather than something wearing its name. Ingest requires both:
-- the session's recorded `genesis_hash` must equal the value here, which a
-- forged chain cannot satisfy because its own genesis is a different event.
--
-- ## One row per chain, not per call
--
-- This is bounded CORRELATION STATE, which is what Postgres is for, and it is
-- deliberately not a call log. A row per authorised call would be an
-- append-only audit stream growing with gateway traffic forever inside the
-- transactional database — the thing AGENTS.md's storage table assigns to
-- ClickHouse and names as a thing Postgres is never for.
--
-- Nothing is lost by collapsing it. The per-call history already exists in
-- ClickHouse: `recordGatewayCall` seals a `tool_call` or `policy_decision`
-- event, carrying the tool, the connected app and the outcome, onto the very
-- chain this row names, and ingest writes those events through
-- `insertTachoEvents`. The only question Postgres has to answer inside a
-- transaction is the one ingest asks — has this host's gateway served this
-- chain, and how recently — and that is exactly what a row is.
--
-- So the row is upserted, and the grants include UPDATE. `last_seen_at` moves
-- forward and nothing else changes; a refused call advances it too, because a
-- call Oxagen stopped is evidence that Oxagen was enforcing, not evidence that
-- it was not.
--
-- Plain DDL only (RDS-compatible); no cross-schema FK, app-enforced per
-- CLAUDE.md; RLS follows the tenant_isolation pattern from 20260612140000.
CREATE TABLE IF NOT EXISTS "tacho"."gateway_chains" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"chain_session_uuid" text NOT NULL,
	-- The hash of that chain's FIRST sealed event, as the gateway stated it.
	--
	-- The chain id above is a name, and a holder of the host's ingest key can
	-- write the same name: open the session first with a chain of its own, wait
	-- for a genuine gateway call to advance `last_seen_at`, and every other check
	-- the server could make is satisfied by the row the forger created. This is
	-- the part it cannot write — a chain that does not begin with the daemon's
	-- own first event has a different genesis hash, and producing a different
	-- chain with the same one is a preimage attack.
	--
	-- Nullable: a daemon too old to send the header records the chain without it,
	-- and ingest then refuses to promote rather than promoting on the name alone.
	"chain_genesis_hash" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tacho_gateway_chains_public_id_unique" UNIQUE("public_id")
);

-- The upsert target AND the read ingest makes: this host's chains, by name.
-- One index serves both because there is one row per (host, chain) — which is
-- the bound, stated as a constraint rather than as an intention.
CREATE UNIQUE INDEX IF NOT EXISTS "tacho_gateway_chains_host_chain_uniq"
  ON "tacho"."gateway_chains" USING btree ("host_id","chain_session_uuid");

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
ALTER TABLE tacho.gateway_chains ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.gateway_chains FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.gateway_chains;
CREATE POLICY tenant_isolation ON tacho.gateway_chains
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
-- UPDATE included because the row is upserted: `last_seen_at` moves forward on
-- every served call. No DELETE — a chain the gateway has served is a fact about
-- that chain, and ingest must not consume it either. Consuming would let a
-- forged batch that arrived first burn a real record belonging to the session
-- that earned it, which trades this defect for a worse one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA tacho TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON tacho.gateway_chains TO oxagen_app';
  END IF;
END
$$;
