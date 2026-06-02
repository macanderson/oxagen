import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  insertValues: vi.fn(),
  insertSpy: vi.fn(),
  createApprovalRequestMock: vi.fn(),
}));

mocks.insertReturning.mockResolvedValue([{ id: "step_id_1" }]);
mocks.insertValues.mockReturnValue({ returning: mocks.insertReturning });
mocks.insertSpy.mockReturnValue({ values: mocks.insertValues });
mocks.createApprovalRequestMock.mockResolvedValue({ approvalId: "appr_1" });

vi.mock("@oxagen/database", () => ({
  db: () => ({ insert: mocks.insertSpy }),
  schema: {
    planSteps: {
      id: "id",
    },
  },
}));

vi.mock("../runtime/approval", () => ({
  createApprovalRequest: mocks.createApprovalRequestMock,
}));

import { agentPlanCreateHandler } from "./agent.plan.create";

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_plan_1",
  surface: "runner" as const,
  messageId: null,
};

const BASE_INPUT = {
  title: "My plan",
  parentMessageId: "msg_1",
  rationale: "To achieve X",
  steps: [
    {
      id: "step_a",
      summary: "Do A",
      intent: "Accomplish A",
      capability: "agent.code.execute",
      inputPreview: { code: "console.log(1)" },
      dependsOn: [],
    },
    {
      id: "step_b",
      summary: "Do B",
      intent: "Accomplish B",
      capability: "documents.generate",
      inputPreview: null,
      dependsOn: ["step_a"],
    },
  ],
};

describe("agent.plan.create handler", () => {
  beforeEach(() => {
    mocks.insertSpy.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertReturning.mockClear();
    mocks.createApprovalRequestMock.mockClear();
    mocks.insertReturning.mockResolvedValue([{ id: "step_id_1" }]);
    mocks.createApprovalRequestMock.mockResolvedValue({ approvalId: "appr_1" });
  });

  it("inserts plan steps and creates an approval request", async () => {
    const result = await agentPlanCreateHandler(BASE_INPUT, CTX);

    expect(mocks.insertSpy).toHaveBeenCalledTimes(1);
    expect(mocks.createApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(mocks.createApprovalRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        workspaceId: "ws_1",
        messageId: "msg_1",
        capabilityName: "agent.plan.create",
        riskLevel: "low",
      }),
    );
    expect(result.status).toBe("pending_approval");
  });

  it("uses requestId as planId fallback when insert returns no id", async () => {
    mocks.insertReturning.mockResolvedValueOnce([]);

    const result = await agentPlanCreateHandler(BASE_INPUT, CTX);

    expect(result.planId).toBe("req_plan_1");
    expect(result.status).toBe("pending_approval");
  });

  it("inserts plan step rows scoped to orgId and workspaceId (tenant isolation)", async () => {
    await agentPlanCreateHandler(BASE_INPUT, CTX);

    const valuesArg = mocks.insertValues.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(valuesArg).toHaveLength(2);
    for (const row of valuesArg) {
      expect(row.orgId).toBe("org_1");
      expect(row.workspaceId).toBe("ws_1");
      expect(row.status).toBe("pending");
    }
  });
});
