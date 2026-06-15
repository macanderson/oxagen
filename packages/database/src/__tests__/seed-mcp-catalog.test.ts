/**
 * Curated MCP marketplace seed — pure-data smoke tests.
 *
 * seedPlatform() runs in EVERY environment (incl. prod via `pnpm db:migrate`)
 * and must leave a populated, browse-only MCP marketplace so a brand-new
 * customer sees servers immediately after signup. These tests validate the
 * shape of the curated catalog array WITHOUT a live DB (the unit harness has
 * none): unique names, valid authKind/status-relevant enums, non-empty
 * descriptions, and — critically — that every row classifies as "mcp_server"
 * per the browse handler's rule (categories must not contain
 * 'integration'/'content_tool').
 *
 * The DB-backed idempotency / row-count assertions (seed runs twice → counts
 * stable, registry has is_default_seed=true) live in
 * integration/seed-mcp-catalog.test.ts and run against a real migrated Postgres.
 */
import { describe, it, expect } from "vitest";
import { MCP_CATALOG_SEED_DATA, OFFICIAL_MCP_REGISTRY } from "../seed";

const VALID_AUTH_KINDS = new Set(["none", "oauth", "secret"]);
// Categories that would re-classify a row away from mcp_server (browse handler).
const RECLASSIFYING_CATEGORIES = new Set(["integration", "content_tool"]);

describe("curated MCP marketplace seed", () => {
  it("seeds a populated marketplace (~10 servers)", () => {
    expect(MCP_CATALOG_SEED_DATA.length).toBeGreaterThanOrEqual(10);
  });

  it("targets the official global registry base URL", () => {
    expect(OFFICIAL_MCP_REGISTRY.baseUrl).toBe(
      "https://registry.modelcontextprotocol.io/v0.1/servers",
    );
    expect(OFFICIAL_MCP_REGISTRY.name).toBe("Official MCP Registry");
  });

  it("every server name is unique (idempotent (registry,name,version) key)", () => {
    const names = MCP_CATALOG_SEED_DATA.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every server has a non-empty name, title, and description", () => {
    for (const s of MCP_CATALOG_SEED_DATA) {
      expect(s.name.trim().length).toBeGreaterThan(0);
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("every server has a valid authKind enum value", () => {
    for (const s of MCP_CATALOG_SEED_DATA) {
      expect(VALID_AUTH_KINDS.has(s.authKind)).toBe(true);
    }
  });

  it("every server has at least one transport type", () => {
    for (const s of MCP_CATALOG_SEED_DATA) {
      expect(s.transportTypes.length).toBeGreaterThan(0);
      for (const t of s.transportTypes) expect(t.trim().length).toBeGreaterThan(0);
    }
  });

  it("every server classifies as mcp_server (no integration/content_tool category)", () => {
    for (const s of MCP_CATALOG_SEED_DATA) {
      for (const c of s.categories) {
        expect(RECLASSIFYING_CATEGORIES.has(c)).toBe(false);
      }
    }
  });

  it("local stdio-only tools use authKind 'none'; hosted services use oauth/secret", () => {
    const byName = new Map(MCP_CATALOG_SEED_DATA.map((s) => [s.name, s]));
    // Spot-check a few canonical classifications.
    expect(byName.get("io.github.modelcontextprotocol/filesystem")?.authKind).toBe("none");
    expect(byName.get("io.github.modelcontextprotocol/github")?.authKind).toBe("oauth");
    expect(byName.get("io.github.modelcontextprotocol/postgres")?.authKind).toBe("secret");
  });
});
