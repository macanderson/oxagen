/**
 * MCP marketplace seed — DB-backed idempotency proof.
 *
 * Runs seedPlatform() against a real migrated Postgres and asserts the
 * browse-only marketplace is populated and idempotent:
 *   1. The global "Official MCP Registry" row exists (org_id NULL,
 *      is_default_seed=true, enabled=true).
 *   2. >= 10 catalog_servers rows are tied to it with is_latest=true,
 *      status='active'.
 *   3. Running seedPlatform() a SECOND time does not throw and does not
 *      duplicate rows (registry + catalog counts are stable).
 *   4. No plugin.org_listings rows are created (browse-only, not installed).
 *
 * CI: rls-integration job (clean migrated DB).
 * Local: DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *          pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { seedPlatform } from "../src/seed";
import { closeDatabase } from "../src/client";
import { OFFICIAL_MCP_REGISTRY, MCP_CATALOG_SEED_DATA } from "../src/seed";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

afterAll(async () => {
  await closeDatabase();
  await sql.end({ timeout: 5 });
});

async function registryRow() {
  const rows = await sql`
    SELECT id, org_id, enabled, is_default_seed
    FROM mcp.registries
    WHERE org_id IS NULL
      AND is_default_seed = true
      AND base_url = ${OFFICIAL_MCP_REGISTRY.baseUrl}
    LIMIT 1
  `;
  return rows[0];
}

async function catalogCount(registryId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS n
    FROM mcp.catalog_servers
    WHERE registry_id = ${registryId}
      AND is_latest = true
      AND status = 'active'
  `;
  return rows[0]?.["n"] ?? 0;
}

describe("seedPlatform MCP marketplace", () => {
  beforeAll(async () => {
    // First seed run. seedPlatform is idempotent so a pre-seeded DB is fine.
    await seedPlatform();
  });

  it("creates the global Official MCP Registry (org_id NULL, default-seed, enabled)", async () => {
    const reg = await registryRow();
    expect(reg).toBeDefined();
    expect(reg!["org_id"]).toBeNull();
    expect(reg!["is_default_seed"]).toBe(true);
    expect(reg!["enabled"]).toBe(true);
  });

  it("populates the browse-only catalog with >= 10 active/latest servers", async () => {
    const reg = await registryRow();
    const count = await catalogCount(reg!["id"] as string);
    expect(count).toBeGreaterThanOrEqual(MCP_CATALOG_SEED_DATA.length);
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it("creates NO plugin.org_listings (browse-only, not installed)", async () => {
    // No listing should carry a seeded server's name without an install.
    const names = MCP_CATALOG_SEED_DATA.map((s) => s.name);
    const rows = await sql`
      SELECT count(*)::int AS n
      FROM plugin.org_listings
      WHERE name = ANY(${names})
    `;
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("is idempotent: a second seedPlatform() run does not throw or duplicate", async () => {
    const reg = await registryRow();
    const regId = reg!["id"] as string;

    const registriesBefore = (
      await sql`SELECT count(*)::int AS n FROM mcp.registries WHERE org_id IS NULL AND is_default_seed = true AND base_url = ${OFFICIAL_MCP_REGISTRY.baseUrl}`
    )[0]?.["n"];
    const catalogBefore = await catalogCount(regId);

    await expect(seedPlatform()).resolves.toBeUndefined();

    const registriesAfter = (
      await sql`SELECT count(*)::int AS n FROM mcp.registries WHERE org_id IS NULL AND is_default_seed = true AND base_url = ${OFFICIAL_MCP_REGISTRY.baseUrl}`
    )[0]?.["n"];
    const catalogAfter = await catalogCount(regId);

    expect(registriesAfter).toBe(registriesBefore);
    expect(catalogAfter).toBe(catalogBefore);
  });
});
