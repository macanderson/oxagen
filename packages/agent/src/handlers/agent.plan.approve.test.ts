import { describe, expect, it, vi, beforeEach } from "vitest";

// Drizzle sql tagged-template chunk shape:
//   literal parts  → { value: string[] }
//   bound params   → plain string
// Capture the sql object passed to db().execute so tests can inspect it.
const executeSpy = vi.fn(async () => undefined);
const whereMock = vi.fn(() => undefined);
const setMock = vi.fn(() => ({ where: whereMock }));
const updateMock = vi.fn(() => ({ set: setMock }));

const fakeDb = { update: updateMock, execute: executeSpy };

vi.mock("@oxagen/database", () => ({
  db: () => fakeDb,
  schema: {
    planSteps: {
      id: "id",
      orgId: "orgId",
      status: "status",
    },
  },
}));

// Use the real drizzle sql so the tagged-template object shape is authentic.
vi.mock("drizzle-orm", async (importOriginal) => {
  const original = await importOriginal<typeof import("drizzle-orm")>();
  return {
    and: original.and,
    eq: original.eq,
    sql: original.sql,
  };
});

import { agentPlanApproveHandler } from "./agent.plan.approve.js";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

describe("agent.plan.approve handler", () => {
  beforeEach(() => {
    executeSpy.mockClear();
    updateMock.mockClear();
    setMock.mockClear();
    whereMock.mockClear();
  });

  it("issues pg_notify with planId and status as bound parameters", async () => {
    const res = await agentPlanApproveHandler(
      { planId: "plan_abc", decision: "approve" },
      CTX,
    );
    expect(res).toEqual({ planId: "plan_abc", status: "approved" });
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const rawCall = (executeSpy.mock.calls as unknown as Array<[unknown]>)[0]!;
    const sqlObj = rawCall[0] as { queryChunks: Array<{ value?: string[] } | string> };
    expect(sqlObj).toHaveProperty("queryChunks");
    const chunks = sqlObj.queryChunks;
    // Static literal parts contain pg_notify.
    const staticText = chunks
      .flatMap((c) => (typeof c === "object" && Array.isArray(c.value) ? c.value : []))
      .join("");
    expect(staticText).toContain("pg_notify");
    // Bound params carry channel and JSON payload.
    const boundParams = chunks.filter((c): c is string => typeof c === "string");
    expect(boundParams).toContain("agent_plan_resolved");
    const payloadParam = boundParams.find((v) => v.includes("plan_abc"));
    expect(payloadParam).toBeTruthy();
    const parsed = JSON.parse(payloadParam!) as { planId: string; status: string };
    expect(parsed.planId).toBe("plan_abc");
    expect(parsed.status).toBe("approved");
  });

  it("hostile planId with SQL metacharacters does not corrupt query or payload", async () => {
    // planId comes from user-controlled input via the HTTP API and should never
    // be concatenated into raw SQL.  This test proves it is always a bound parameter.
    const hostilePlanId = "plan_1'; DROP TABLE plan_steps; -- ') SELECT 1";
    const res = await agentPlanApproveHandler(
      { planId: hostilePlanId, decision: "approve" },
      CTX,
    );
    expect(res.planId).toBe(hostilePlanId);
    expect(res.status).toBe("approved");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const rawCall2 = (executeSpy.mock.calls as unknown as Array<[unknown]>)[0]!;
    const sqlObj = rawCall2[0] as { queryChunks: Array<{ value?: string[] } | string> };
    expect(sqlObj).toHaveProperty("queryChunks");
    const chunks = sqlObj.queryChunks;
    // Literal static parts must NOT contain the hostile input.
    const staticText = chunks
      .flatMap((c) => (typeof c === "object" && Array.isArray(c.value) ? c.value : []))
      .join("");
    expect(staticText).not.toContain(hostilePlanId);
    expect(staticText).not.toContain("DROP TABLE");
    // The payload must be a bound parameter containing the hostile planId verbatim.
    const boundParams = chunks.filter((c): c is string => typeof c === "string");
    const payloadParam = boundParams.find((v) => v.includes("plan_1"));
    expect(payloadParam).toBeTruthy();
    const parsed = JSON.parse(payloadParam!) as { planId: string; status: string };
    // planId preserved exactly — including every hostile character — without escaping or truncation.
    expect(parsed.planId).toBe(hostilePlanId);
    expect(parsed.status).toBe("approved");
  });
});
