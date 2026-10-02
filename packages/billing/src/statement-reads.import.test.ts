/**
 * The statement modules read no table at import.
 *
 * `@oxagen/billing`'s index re-exports statement-reads.ts, and hundreds of
 * test files across the repo mock `@oxagen/database` with a schema holding
 * only the tables they use. A module-scope `schema.gauLedger` would make every
 * one of them fail at collection (the incident `gauRemainingSql()` in
 * gau-bucket.ts records). This suite loads the modules against an empty
 * schema: it fails the moment a table is touched outside a function.
 */
import { describe, expect, it, vi } from "vitest";

// The first import of the three modules compiles them cold. On a busy CI
// runner with coverage on, that passes the 5-second default (#5037).
vi.setConfig({ testTimeout: 30_000 });

vi.mock("@oxagen/database", () => ({
  schema: {},
  withOrgDb: vi.fn(),
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
}));

describe("statement modules at import", () => {
  it("load against a schema with no tables", async () => {
    const reads = await import("./statement-reads");
    const statements = await import("./statements");
    const render = await import("./statement-render");
    expect(typeof reads.buildBillingStatement).toBe("function");
    expect(typeof statements.resolveStatementPeriod).toBe("function");
    expect(typeof render.renderStatementHtml).toBe("function");
  });
});
