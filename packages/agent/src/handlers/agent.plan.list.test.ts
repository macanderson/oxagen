import { describe, expect, it, vi, beforeEach } from "vitest";

let selectRows: unknown[] = [];
let capturedLimit = 0;

const fakeDb = {
  select: (_cols: unknown) => ({
    from: (_t: unknown) => ({
      where: (_w: unknown) => ({
        orderBy: (_o: unknown) => ({
          limit: async (n: number) => {
            capturedLimit = n;
            return selectRows;
          },
        }),
      }),
    }),
  }),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
});

import { agentPlanListHandler } from "./agent.plan.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

function row(id: string, createdAt: string) {
  return {
    publicId: id,
    status: "draft",
    goals: ["g"],
    approvalRequired: true,
    approvedAt: null,
    taskCount: 1,
    createdAt: new Date(createdAt),
  };
}

describe("agent.plan.list handler", () => {
  beforeEach(() => {
    selectRows = [];
    capturedLimit = 0;
  });

  it("returns a page with no nextCursor when fewer than limit+1 rows", async () => {
    selectRows = [
      row("apl_2", "2026-05-02T00:00:00Z"),
      row("apl_1", "2026-05-01T00:00:00Z"),
    ];
    const out = await agentPlanListHandler({ limit: 20 }, CTX);
    expect(capturedLimit).toBe(21); // over-fetch by one
    expect(out.plans).toHaveLength(2);
    expect(out.nextCursor).toBeNull();
    expect(out.plans[0]).toMatchObject({ planId: "apl_2", status: "draft" });
  });

  it("truncates to limit and sets nextCursor when more rows exist", async () => {
    // limit 2, but 3 rows returned (over-fetch detected more)
    selectRows = [
      row("apl_3", "2026-05-03T00:00:00Z"),
      row("apl_2", "2026-05-02T00:00:00Z"),
      row("apl_1", "2026-05-01T00:00:00Z"),
    ];
    const out = await agentPlanListHandler({ limit: 2 }, CTX);
    expect(out.plans).toHaveLength(2);
    expect(out.nextCursor).toBe(new Date("2026-05-02T00:00:00Z").toISOString());
  });

  it("maps summary fields including null approvedAt", async () => {
    selectRows = [row("apl_1", "2026-05-01T00:00:00Z")];
    const out = await agentPlanListHandler({ limit: 20 }, CTX);
    expect(out.plans[0]).toEqual({
      planId: "apl_1",
      status: "draft",
      goals: ["g"],
      approvalRequired: true,
      approvedAt: null,
      taskCount: 1,
      createdAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    });
  });
});
