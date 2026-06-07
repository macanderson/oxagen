-- 0011_mcp_registries_write_scope.sql
--
-- Tighten the mcp.registries RLS policy to asymmetric read/write (OXA-1515 / SOC2 CC6.3).
--
-- 0010 gave mcp.registries an org_or_global policy where USING == WITH CHECK:
-- both reads AND writes allowed `org_id IS NULL OR org_id = current_org`. That read
-- rule is correct (every tenant must see the global, NULL-org default-seed registry
-- plus its own rows), but the SAME rule on WITH CHECK is a privilege-escalation hole:
-- a tenant could INSERT/UPDATE a row with org_id = NULL and thereby publish a
-- PLATFORM-WIDE MCP registry endpoint visible to every other tenant — an SSRF /
-- supply-chain vector (everyone would resolve plugins from the attacker's registry).
--
-- This migration recreates the policy with split predicates:
--   • READS  (USING):     global (NULL) rows + own-org rows.   [unchanged]
--   • WRITES (WITH CHECK): own-org rows ONLY. Creating/altering a global (NULL)
--     registry is reserved for the seeding/system path (app.rls_bypass='on').
--
-- 0010 is immutable (already applied to preview); this is the forward migration
-- that supersedes its mcp.registries policy. Matches the org_or_global predicates
-- emitted by tools/scripts/gen-rls-migration.ts. Idempotent: DROP POLICY IF EXISTS
-- + CREATE. Applied by pnpm db:migrate via public._migrations.

SET search_path TO public;

BEGIN;

DROP POLICY IF EXISTS tenant_isolation ON mcp.registries;
CREATE POLICY tenant_isolation ON mcp.registries
  -- READS: own-org rows + the global (NULL org_id) default-seed catalog.
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id IS NULL OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  -- WRITES: own-org rows ONLY. Publishing a global (NULL) registry is reserved for
  -- the seeding/system path (app.rls_bypass='on') to prevent a tenant from shipping
  -- a platform-wide malicious MCP endpoint (SSRF / supply chain).
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
