import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture what the handler writes + the pg_notify sql object.
let capturedSet: Record<string, unknown> | null = null;
let returningRows: Array<{ publicId: string }> = [{ publicId: "plan_abc" }];
const executeSpy = vi.fn(async (_sql: unknown) => undefined);

const fakeDb = {
  update: (_table: unknown) => ({
    set: (vals: Record<string, unknown>) => {
      capturedSet = vals;
      return {
        where: (_w: unknown) => ({
          returning: async () => returningRows,
        }),
      };
    },
  }),
  execute: executeSpy,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
  };
});

// Use the real drizzle sql so the tagged-template object shape is authentic.

import { agentPlanApproveHandler } from "./agent.plan.approve";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.plan.approve handler", () => {
  beforeEach(() => {
    executeSpy.mockClear();
    capturedSet = null;
    returningRows = [{ publicId: "plan_abc" }];
  });

  it("persists the approval on the plan row AND notifies", async () => {
    const res = await agentPlanApproveHandler(
      { planId: "plan_abc", decision: "approve" },
      CTX,
    );
    expect(res).toEqual({ planId: "plan_abc", status: "approved" });
    // Row updated with resolution state.
    expect(capturedSet).toMatchObject({
      status: "approved",
      approvedByUserId: CTX.userId,
    });
    expect(capturedSet?.approvedAt).toBeInstanceOf(Date);
    // NOTIFY still fires to release the stream.
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("deny leaves approvedAt null but records who denied", async () => {
    const res = await agentPlanApproveHandler(
      { planId: "plan_abc", decision: "deny" },
      CTX,
    );
    expect(res.status).toBe("denied");
    expect(capturedSet?.status).toBe("denied");
    expect(capturedSet?.approvedAt).toBeNull();
    expect(capturedSet?.approvedByUserId).toBe(CTX.userId);
  });

  it("amend persists the amended steps and task count", async () => {
    const amendedSteps = [
      {
        id: "s1",
        summary: "do a",
        intent: "x",
        capability: null,
        inputPreview: null,
        dependsOn: [],
      },
      {
        id: "s2",
        summary: "do b",
        intent: "y",
        capability: null,
        inputPreview: null,
        dependsOn: ["s1"],
      },
    ];
    const res = await agentPlanApproveHandler(
      { planId: "plan_abc", decision: "amend", amendedSteps },
      CTX,
    );
    expect(res.status).toBe("amended");
    expect(capturedSet?.tasks).toEqual(amendedSteps);
    expect(capturedSet?.taskCount).toBe(2);
  });

  it("throws when the plan does not exist (or belongs to another tenant)", async () => {
    returningRows = [];
    await expect(
      agentPlanApproveHandler(
        { planId: "plan_missing", decision: "approve" },
        CTX,
      ),
    ).rejects.toThrow(/not found/i);
    // No NOTIFY for a plan that was never resolved.
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("issues pg_notify with planId and status as bound parameters", async () => {
    await agentPlanApproveHandler(
      { planId: "plan_abc", decision: "approve" },
      CTX,
    );
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const sqlObj = executeSpy.mock.calls[0]![0] as {
      queryChunks: Array<{ value?: string[] } | string>;
    };
    expect(sqlObj).toHaveProperty("queryChunks");
    const chunks = sqlObj.queryChunks;
    const staticText = chunks
      .flatMap((c) =>
        typeof c === "object" && Array.isArray(c.value) ? c.value : [],
      )
      .join("");
    expect(staticText).toContain("pg_notify");
    const boundParams = chunks.filter(
      (c): c is string => typeof c === "string",
    );
    expect(boundParams).toContain("agent_plan_resolved");
    const payloadParam = boundParams.find((v) => v.includes("plan_abc"));
    expect(payloadParam).toBeTruthy();
    const parsed = JSON.parse(payloadParam!) as {
      planId: string;
      status: string;
    };
    expect(parsed).toEqual({ planId: "plan_abc", status: "approved" });
  });

  it("hostile planId with SQL metacharacters is never concatenated into SQL", async () => {
    const hostilePlanId = "plan_1'; DROP TABLE agent_plans; -- ') SELECT 1";
    returningRows = [{ publicId: hostilePlanId }];
    const res = await agentPlanApproveHandler(
      { planId: hostilePlanId, decision: "approve" },
      CTX,
    );
    expect(res.planId).toBe(hostilePlanId);
    const sqlObj = executeSpy.mock.calls[0]![0] as {
      queryChunks: Array<{ value?: string[] } | string>;
    };
    const staticText = (
      sqlObj.queryChunks as Array<{ value?: string[] } | string>
    )
      .flatMap((c) =>
        typeof c === "object" && Array.isArray(c.value) ? c.value : [],
      )
      .join("");
    expect(staticText).not.toContain(hostilePlanId);
    expect(staticText).not.toContain("DROP TABLE");
    const boundParams = (
      sqlObj.queryChunks as Array<{ value?: string[] } | string>
    ).filter((c): c is string => typeof c === "string");
    const payloadParam = boundParams.find((v) => v.includes("plan_1"));
    const parsed = JSON.parse(payloadParam!) as { planId: string };
    expect(parsed.planId).toBe(hostilePlanId);
  });
});
