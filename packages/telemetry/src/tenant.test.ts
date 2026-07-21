// tenant.test.ts — ClickHouse tenant seam (chInsert / chSelect)
//
// Validates the four security invariants:
//   1. chInsert stamps org_id/workspace_id from scope onto every row.
//   2. chSelect binds orgId/workspaceId as query params.
//   3. chSelect rejects a query that omits org_id (cross-tenant read guard).
//   4. Both helpers fail closed when no tenant scope is active.

import { describe, expect, it, vi } from "vitest";

// Hoist the mock fns so they are available inside the vi.mock() factory.
const insert = vi.hoisted(() => vi.fn(async () => undefined));
const query = vi.hoisted(() =>
  vi.fn(async () => ({
    json: async <T>(): Promise<T> => ({ data: [] }) as unknown as T,
  })),
);

// Mock the ClickHouse singleton. tenant.ts imports from "./clickhouse" so we
// mock that module (client.ts is just a re-export barrel — not the import site).
vi.mock("./clickhouse", () => ({
  clickhouse: () => ({ insert, query }),
}));

import { runInTenantScope } from "@oxagen/tenancy";
import { chInsert, chSelect } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("clickhouse tenant seam", () => {
  it("stamps org_id/workspace_id onto inserted rows", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chInsert("events", [{ event_type: "x" }]),
    );
    expect(insert).toHaveBeenCalledWith({
      table: "events",
      values: [{ event_type: "x", org_id: ORG, workspace_id: WS }],
      format: "JSONEachRow",
    });
  });

  it("overwrites hostile caller-supplied tenant columns", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chInsert("events", [
        {
          event_type: "x",
          org_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          workspace_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
      ]),
    );

    expect(insert).toHaveBeenCalledWith({
      table: "events",
      values: [{ event_type: "x", org_id: ORG, workspace_id: WS }],
      format: "JSONEachRow",
    });
  });

  it("binds orgId/workspaceId as query params on read", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chSelect({ query: "SELECT 1 WHERE org_id = {orgId:UUID}" }),
    );
    expect(query).toHaveBeenCalledOnce();
    // Extract the first argument of the first call. Cast through unknown since
    // vi.fn() infers void params; the shape is validated by the assertions below.
    const callArg = query.mock.calls[0] as unknown as [
      { query: string; query_params: Record<string, string>; format: string },
    ];
    expect(callArg[0]?.query_params.orgId).toBe(ORG);
    expect(callArg[0]?.query_params.workspaceId).toBe(WS);
  });

  it("rejects a read query that omits org_id (guard)", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await expect(chSelect({ query: "SELECT 1" })).rejects.toThrow(/org_id/);
    });
  });

  it("fails closed with no scope", async () => {
    await expect(chInsert("events", [{}])).rejects.toThrow(/tenant scope/);
  });
});
