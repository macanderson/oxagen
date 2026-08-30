// barrel.test.ts
//
// Smoke-tests that the public export surfaces of client.ts and index.ts
// re-export the expected symbols. These ensure the barrel files are exercised
// by the coverage run and that the public API surface doesn't accidentally
// shrink.

import { describe, expect, it } from "vitest";

// We mock the underlying deps so no real ClickHouse connection is needed.
import { vi } from "vitest";

vi.mock("@clickhouse/client", () => ({
  createClient: vi.fn(() => ({
    close: vi.fn(),
    insert: vi.fn(),
    query: vi.fn(),
  })),
}));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    CLICKHOUSE_URL: "https://ch.example",
    CLICKHOUSE_USERNAME: "u",
    CLICKHOUSE_PASSWORD: "p",
    CLICKHOUSE_DATABASE: "db",
  }),
}));

describe("client.ts barrel exports", () => {
  it("exports clickhouse, closeClickhouse, sumTokenUsage", async () => {
    const mod = await import("./client");
    expect(typeof mod.clickhouse).toBe("function");
    expect(typeof mod.closeClickhouse).toBe("function");
    expect(typeof mod.sumTokenUsage).toBe("function");
  }, 15000);
});

describe("index.ts barrel exports", () => {
  it("exports the expected public symbols", async () => {
    const mod = await import("./index");
    // Core client
    expect(typeof mod.clickhouse).toBe("function");
    expect(typeof mod.closeClickhouse).toBe("function");
    expect(typeof mod.sumTokenUsage).toBe("function");
    // Insert helpers
    expect(typeof mod.insertExecutionLogs).toBe("function");
    expect(typeof mod.insertEvents).toBe("function");
    expect(typeof mod.insertTokenUsage).toBe("function");
    expect(typeof mod.insertToolInvocation).toBe("function");
    expect(typeof mod.insertAuditEvent).toBe("function");
    // Utility
    expect(typeof mod.hashPrompt).toBe("function");
    expect(typeof mod.providerFromModelId).toBe("function");
    expect(typeof mod.latestAuditChainHash).toBe("function");
    // Migrate
    expect(typeof mod.migrateClickhouse).toBe("function");
    // Security
    expect(typeof mod.chInsert).toBe("function");
    expect(typeof mod.chSelect).toBe("function");
    // Skill telemetry
    expect(typeof mod.recordSkillLoad).toBe("function");
    expect(typeof mod.readSkillMetrics).toBe("function");
  });
});
