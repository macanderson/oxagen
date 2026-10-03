// The work item reads against a real Postgres (#2962). The handler test drives
// the run lines through fakes. This runs the SQL: the send join and the direct
// work order join, in a tenant scope that holds no row. Postgres parses and
// plans each statement, so a bad join or column fails here rather than in an
// export, and each read answers nothing.
//
// Runs wherever DATABASE_URL points at a migrated database (CI's `test` job).
// A local run without one is skipped, not red. It writes no rows.
import { closeDatabase } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, describe, expect, it } from "vitest";
import { readRunWorkItems } from "./run-work-items";

const enabled = Boolean(process.env.DATABASE_URL);

afterAll(async () => {
  if (enabled) await closeDatabase();
});

describe.skipIf(!enabled)("run work items against Postgres", () => {
  const scope = {
    orgId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
  };

  it("names no work item for work orders the workspace does not hold", async () => {
    const found = await runInTenantScope(scope, () =>
      readRunWorkItems(scope, [
        { workOrderId: crypto.randomUUID(), workOrderKind: "send" },
        { workOrderId: crypto.randomUUID(), workOrderKind: "direct" },
      ]),
    );
    expect(found.size).toBe(0);
  });

  it("asks nothing when no run names a work order", async () => {
    expect(
      (await runInTenantScope(scope, () => readRunWorkItems(scope, []))).size,
    ).toBe(0);
  });
});
