/**
 * Schema smoke tests for plugin.installed_plugins (formerly org_listings).
 *
 * Operates entirely on Drizzle TypeScript table definitions via `getTableConfig`
 * — no live DB, no network.
 *
 * Assertions:
 *  1. PLUGIN_TYPES constant includes the 5 canonical types:
 *     agent_skill, agent_capability, mcp_server, knowledge_source, integration.
 *  2. installed_plugins type CHECK includes all five plugin_type values.
 *  3. installed_plugins source CHECK includes all three source values (registry,
 *     custom, oxagen).
 *  4. Every value in PLUGIN_TYPES appears in installed_plugins type CHECK SQL
 *     (no drift between the constant and the constraint).
 *  5. pluginInstalledPlugins has a NOT NULL workspace_id column.
 *  6. pluginInstalledPlugins does NOT have a catalog_server_id column.
 *  7. pluginOrgDenylist is NOT exported from the schema (table is gone).
 */

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { PLUGIN_TYPES, pluginInstalledPlugins } from "../schema/plugin";
import { flattenCheckSql, type DrizzleCheck } from "./_test-helpers";

// ---------------------------------------------------------------------------
// 1. PLUGIN_TYPES constant — must include all five canonical values
// ---------------------------------------------------------------------------

describe("PLUGIN_TYPES constant", () => {
  it("contains 'agent_skill'", () => {
    expect(PLUGIN_TYPES).toContain("agent_skill");
  });

  it("contains 'agent_capability'", () => {
    expect(PLUGIN_TYPES).toContain("agent_capability");
  });

  it("contains 'mcp_server'", () => {
    expect(PLUGIN_TYPES).toContain("mcp_server");
  });

  it("contains 'knowledge_source'", () => {
    expect(PLUGIN_TYPES).toContain("knowledge_source");
  });

  it("contains 'integration'", () => {
    expect(PLUGIN_TYPES).toContain("integration");
  });

  it("contains 'mcp_server_local'", () => {
    expect(PLUGIN_TYPES).toContain("mcp_server_local");
  });

  it("has exactly six members", () => {
    expect(PLUGIN_TYPES).toHaveLength(6);
  });

  it("does NOT contain the old 'content_tool' type", () => {
    expect(PLUGIN_TYPES).not.toContain("content_tool");
  });

  it("does NOT contain the old 'capability' type", () => {
    expect(PLUGIN_TYPES).not.toContain("capability");
  });
});

// ---------------------------------------------------------------------------
// 2. installed_plugins: type CHECK — must include all five plugin_type values
// ---------------------------------------------------------------------------

describe("pluginInstalledPlugins — installed_plugins_type_check CHECK constraint", () => {
  const cfg = getTableConfig(pluginInstalledPlugins);
  const checks = cfg.checks as DrizzleCheck[];
  const typeCheck = checks.find(
    (c) => c.name === "installed_plugins_type_check",
  );

  it("has an 'installed_plugins_type_check' constraint", () => {
    expect(
      typeCheck,
      `Expected CHECK named "installed_plugins_type_check" but found: [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  const EXPECTED_TYPES = [
    "agent_skill",
    "agent_capability",
    "mcp_server",
    "knowledge_source",
    "integration",
  ];

  for (const t of EXPECTED_TYPES) {
    it(`type CHECK SQL includes '${t}'`, () => {
      const sql = flattenCheckSql(typeCheck!);
      expect(sql, `CHECK SQL was: "${sql}"`).toContain(t);
    });
  }

  it("PLUGIN_TYPES and type CHECK SQL are in sync (no drift)", () => {
    const sql = flattenCheckSql(typeCheck!);
    for (const t of PLUGIN_TYPES) {
      expect(
        sql,
        `PLUGIN_TYPES has '${t}' but it is missing from installed_plugins_type_check SQL: "${sql}"`,
      ).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. installed_plugins: source CHECK — must include registry, custom, oxagen
// ---------------------------------------------------------------------------

describe("pluginInstalledPlugins — installed_plugins_source_check CHECK constraint", () => {
  const cfg = getTableConfig(pluginInstalledPlugins);
  const checks = cfg.checks as DrizzleCheck[];
  const sourceCheck = checks.find(
    (c) => c.name === "installed_plugins_source_check",
  );

  it("has an 'installed_plugins_source_check' constraint", () => {
    expect(
      sourceCheck,
      `Expected CHECK named "installed_plugins_source_check" but found: [${checks.map((c) => c.name).join(", ")}]`,
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
// 4. installed_plugins: workspace_id must be NOT NULL
// ---------------------------------------------------------------------------

describe("pluginInstalledPlugins — workspace_id column", () => {
  const cfg = getTableConfig(pluginInstalledPlugins);
  const wsCol = cfg.columns.find((c) => c.name === "workspace_id");

  it("has a 'workspace_id' column", () => {
    expect(
      wsCol,
      `Expected column "workspace_id" but found: [${cfg.columns.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  it("workspace_id is NOT NULL", () => {
    expect(wsCol?.notNull).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. installed_plugins: catalog_server_id must NOT exist
// ---------------------------------------------------------------------------

describe("pluginInstalledPlugins — catalog_server_id column removed", () => {
  const cfg = getTableConfig(pluginInstalledPlugins);
  const catalogCol = cfg.columns.find((c) => c.name === "catalog_server_id");

  it("does NOT have a 'catalog_server_id' column", () => {
    expect(
      catalogCol,
      `Column "catalog_server_id" should have been removed but is still present`,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. pluginOrgDenylist must NOT be exported from the plugin schema module
// ---------------------------------------------------------------------------

describe("pluginOrgDenylist — table removed", () => {
  it("is NOT exported from the plugin schema module", async () => {
    const mod = await import("../schema/plugin");
    expect(
      (mod as Record<string, unknown>)["pluginOrgDenylist"],
    ).toBeUndefined();
  });
});
