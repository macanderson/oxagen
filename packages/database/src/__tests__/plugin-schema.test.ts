/**
 * Schema smoke tests for plugin.org_listings and plugin.org_denylist.
 *
 * Operates entirely on Drizzle TypeScript table definitions via `getTableConfig`
 * — no live DB, no network.
 *
 * Assertions:
 *  1. PLUGIN_TYPES constant includes all four values (mcp_server, integration,
 *     content_tool, capability).
 *  2. org_listings type CHECK includes all four plugin_type values.
 *  3. org_listings source CHECK includes all three source values (registry,
 *     custom, oxagen).
 *  4. org_denylist type CHECK includes all four plugin_type values (capability
 *     plugins can be denylisted too).
 *  5. Every value in PLUGIN_TYPES appears in org_listings type CHECK SQL
 *     (no drift between the constant and the constraint).
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  PLUGIN_TYPES,
  pluginOrgListings,
  pluginOrgDenylist,
} from "../schema/plugin";
import { flattenCheckSql, type DrizzleCheck } from "./_test-helpers";

// ---------------------------------------------------------------------------
// 1. PLUGIN_TYPES constant — must include all four values
// ---------------------------------------------------------------------------

describe("PLUGIN_TYPES constant", () => {
  it("contains 'mcp_server'", () => {
    expect(PLUGIN_TYPES).toContain("mcp_server");
  });

  it("contains 'integration'", () => {
    expect(PLUGIN_TYPES).toContain("integration");
  });

  it("contains 'content_tool'", () => {
    expect(PLUGIN_TYPES).toContain("content_tool");
  });

  it("contains 'capability'", () => {
    expect(PLUGIN_TYPES).toContain("capability");
  });

  it("has exactly four members", () => {
    expect(PLUGIN_TYPES).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 2. org_listings: org_listings_type_check — must include all four plugin_type values
// ---------------------------------------------------------------------------

describe("pluginOrgListings — org_listings_type_check CHECK constraint", () => {
  const cfg = getTableConfig(pluginOrgListings);
  const checks = cfg.checks as DrizzleCheck[];
  const typeCheck = checks.find((c) => c.name === "org_listings_type_check");

  it("has a 'org_listings_type_check' constraint", () => {
    expect(
      typeCheck,
      `Expected CHECK named "org_listings_type_check" but found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  const EXPECTED_TYPES = ["mcp_server", "integration", "content_tool", "capability"];

  for (const t of EXPECTED_TYPES) {
    it(`type CHECK SQL includes '${t}'`, () => {
      const sql = flattenCheckSql(typeCheck!);
      expect(sql, `CHECK SQL was: "${sql}"`).toContain(t);
    });
  }

  it("PLUGIN_TYPES and type CHECK SQL are in sync (no drift)", () => {
    const sql = flattenCheckSql(typeCheck!);
    for (const t of PLUGIN_TYPES) {
      expect(sql, `PLUGIN_TYPES has '${t}' but it is missing from org_listings_type_check SQL: "${sql}"`).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. org_listings: org_listings_source_check — must include registry, custom, oxagen
// ---------------------------------------------------------------------------

describe("pluginOrgListings — org_listings_source_check CHECK constraint", () => {
  const cfg = getTableConfig(pluginOrgListings);
  const checks = cfg.checks as DrizzleCheck[];
  const sourceCheck = checks.find((c) => c.name === "org_listings_source_check");

  it("has a 'org_listings_source_check' constraint", () => {
    expect(
      sourceCheck,
      `Expected CHECK named "org_listings_source_check" but found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  const EXPECTED_SOURCES = ["registry", "custom", "oxagen"];

  for (const s of EXPECTED_SOURCES) {
    it(`source CHECK SQL includes '${s}'`, () => {
      const sql = flattenCheckSql(sourceCheck!);
      expect(sql, `CHECK SQL was: "${sql}"`).toContain(s);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. org_denylist: org_denylist_type_check — must include all four plugin_type values
// ---------------------------------------------------------------------------

describe("pluginOrgDenylist — org_denylist_type_check CHECK constraint", () => {
  const cfg = getTableConfig(pluginOrgDenylist);
  const checks = cfg.checks as DrizzleCheck[];
  const typeCheck = checks.find((c) => c.name === "org_denylist_type_check");

  it("has a 'org_denylist_type_check' constraint", () => {
    expect(
      typeCheck,
      `Expected CHECK named "org_denylist_type_check" but found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  const EXPECTED_TYPES = ["mcp_server", "integration", "content_tool", "capability"];

  for (const t of EXPECTED_TYPES) {
    it(`denylist type CHECK SQL includes '${t}'`, () => {
      const sql = flattenCheckSql(typeCheck!);
      expect(sql, `CHECK SQL was: "${sql}"`).toContain(t);
    });
  }
});
