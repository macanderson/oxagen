import { describe, expect, it, vi, beforeEach } from "vitest";

let selectRows: unknown[] = [];

const fakeDb = {
  select: (_cols: unknown) => ({
    from: (_t: unknown) => ({
      where: (_w: unknown) => ({
        limit: async (_n: number) => selectRows,
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

import { agentPlanGetHandler } from "./agent.plan.get";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.plan.get handler", () => {
  beforeEach(() => {
    selectRows = [];
  });

  it("maps a plan row to the view shape", async () => {
    const created = new Date("2026-05-01T00:00:00Z");
    const approved = new Date("2026-05-02T00:00:00Z");
    selectRows = [
      {
        publicId: "apl_1",
        status: "approved",
        goals: ["ship it"],
        constraints: ["no prod writes"],
        tasks: [{ id: "t1", title: "x" }],
        approvalRequired: true,
        approvedAt: approved,
        approvedByUserId: "u_1",
        taskCount: 1,
        createdAt: created,
      },
    ];
    const out = await agentPlanGetHandler({ planId: "apl_1" }, CTX);
    expect(out).toEqual({
      planId: "apl_1",
      status: "approved",
      goals: ["ship it"],
      constraints: ["no prod writes"],
      tasks: [{ id: "t1", title: "x" }],
      approvalRequired: true,
      approvedAt: approved.toISOString(),
      approvedByUserId: "u_1",
      taskCount: 1,
      createdAt: created.toISOString(),
    });
  });

  it("null approvedAt/approvedByUserId map to null", async () => {
    selectRows = [
      {
        publicId: "apl_2",
        status: "awaiting_approval",
        goals: [],
        constraints: [],
        tasks: [],
        approvalRequired: true,
        approvedAt: null,
        approvedByUserId: null,
        taskCount: 0,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ];
    const out = await agentPlanGetHandler({ planId: "apl_2" }, CTX);
    expect(out.approvedAt).toBeNull();
    expect(out.approvedByUserId).toBeNull();
  });

  it("throws when the plan is not found", async () => {
    selectRows = [];
    await expect(
      agentPlanGetHandler({ planId: "apl_missing" }, CTX),
    ).rejects.toThrow(/not found/i);
  });
});
