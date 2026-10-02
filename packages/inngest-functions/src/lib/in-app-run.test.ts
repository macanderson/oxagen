import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.shared";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
}));

vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  return { ...actual, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

const { isInAppRun } = await import("./in-app-run");

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000a2",
};
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000b1";

/**
 * Hands the read a drizzle client that records each statement and answers
 * `rows`, as if Postgres had.
 */
function answer(rows: unknown[][]) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = drizzle(async (text, params) => {
    statements.push({ sql: text, params });
    return { rows };
  });
  mocks.withTenantDb.mockImplementation((fn: (tx: typeof db) => unknown) =>
    fn(db),
  );
  return statements;
}

beforeEach(() => {
  mocks.withTenantDb.mockReset();
  mocks.runInTenantScope.mockReset();
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
});

describe("isInAppRun", () => {
  it("reads true for a run on an in-app surface, inside the run's tenant scope", async () => {
    const statements = answer([[RUN_UUID]]);
    expect(await isInAppRun(SCOPE, "arun_assistant")).toBe(true);
    expect(mocks.runInTenantScope).toHaveBeenCalledWith(
      SCOPE,
      expect.any(Function),
    );
    const [q] = statements;
    expect(q!.sql).toMatch(/"agent_runs"\."org_id" = \$\d+/);
    expect(q!.sql).toMatch(/"agent_runs"\."workspace_id" = \$\d+/);
    expect(q!.sql).toMatch(/"agent_runs"\."public_id" = \$\d+/);
    expect(q!.sql).toMatch(/"agent_runs"\."surface" in \(\$\d+, \$\d+\)/);
    expect(q!.params).toEqual(
      expect.arrayContaining([
        SCOPE.orgId,
        SCOPE.workspaceId,
        "arun_assistant",
        ...IN_APP_AGENT_SURFACES,
      ]),
    );
  });

  it("reads false for a ledger run on another surface", async () => {
    answer([]);
    expect(await isInAppRun(SCOPE, "arun_external")).toBe(false);
  });

  it("reads false for a Tacho session without a query", async () => {
    answer([]);
    expect(await isInAppRun(SCOPE, "tse_abc")).toBe(false);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.runInTenantScope).not.toHaveBeenCalled();
  });
});
