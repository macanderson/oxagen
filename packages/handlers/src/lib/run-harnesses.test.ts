import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withTenantDb,
  };
});

import { readRunHarnesses } from "./run-harnesses";

const scope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const sessionId = "tse_0000000000000000000001";
const ledgerId = "arun_000000000000000000001";

describe("readRunHarnesses", () => {
  // A block body, not an expression: mockReset() returns the mock, and a
  // function a beforeEach returns runs as that test's teardown, with no
  // arguments and with the test's implementation still installed.
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("reads the recorded harness within the caller's org and workspace", async () => {
    const db = drizzle.mock({ schema });
    const captured: { sql: string; params: unknown[] }[] = [];
    mocks.withTenantDb.mockImplementation((fn: (tx: typeof db) => unknown) => {
      const query = fn(db) as { toSQL(): { sql: string; params: unknown[] } };
      captured.push(query.toSQL());
      return Promise.resolve([{ publicId: sessionId, harness: "codex" }]);
    });
    const result = await readRunHarnesses(scope, [
      sessionId,
      sessionId,
      ledgerId,
    ]);
    expect(result.get(sessionId)).toBe("codex");
    expect(result.has(ledgerId)).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/"org_id" = \$\d+/);
    expect(captured[0]?.sql).toMatch(/"workspace_id" = \$\d+/);
    expect(captured[0]?.params).toEqual([
      scope.orgId,
      scope.workspaceId,
      sessionId,
    ]);
  });

  it("leaves missing and blank harnesses unknown", async () => {
    mocks.withTenantDb.mockResolvedValue([{ publicId: sessionId, harness: "" }]);
    const result = await readRunHarnesses(scope, [sessionId, "tse_missing"]);
    expect(result.get(sessionId)).toBeNull();
    expect(result.has("tse_missing")).toBe(false);
  });

  it("does not query for an empty list or ledger-only runs", async () => {
    expect(await readRunHarnesses(scope, [])).toEqual(new Map());
    expect(await readRunHarnesses(scope, [ledgerId])).toEqual(new Map());
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
