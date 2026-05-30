import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  returningMock: vi.fn(),
  whereMock: vi.fn(),
  setMock: vi.fn(),
  updateMock: vi.fn(),
  andArgsRecord: [] as unknown[][],
  sqlArgsRecord: [] as string[],
  notifyResolutionMock: vi.fn(async () => undefined),
}));

mocks.whereMock.mockImplementation(() => ({ returning: mocks.returningMock }));
mocks.setMock.mockImplementation(() => ({ where: mocks.whereMock }));
mocks.updateMock.mockImplementation(() => ({ set: mocks.setMock }));

vi.mock("@oxagen/database", () => ({
  db: () => ({ update: mocks.updateMock }),
  schema: {
    approvalRequests: {
      id: "id",
      orgId: "orgId",
      expiresAt: "expiresAt",
      resolution: "resolution",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => {
    mocks.andArgsRecord.push(args);
    return { _and: args };
  },
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
  sql: (strings: TemplateStringsArray) => {
    const raw = strings.join("?");
    mocks.sqlArgsRecord.push(raw);
    return { _sql: raw };
  },
}));

vi.mock("../runtime/approval.js", () => ({
  notifyResolution: mocks.notifyResolutionMock,
}));

import { agentApprovalResolveHandler } from "./agent.approval.resolve.js";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("agent.approval.resolve handler", () => {
  beforeEach(() => {
    mocks.returningMock.mockReset();
    mocks.updateMock.mockClear();
    mocks.setMock.mockClear();
    mocks.whereMock.mockClear();
    mocks.notifyResolutionMock.mockClear();
    mocks.andArgsRecord.length = 0;
    mocks.sqlArgsRecord.length = 0;
  });

  it("approves when a row is updated and emits NOTIFY", async () => {
    mocks.returningMock.mockResolvedValueOnce([{ id: "appr_1" }]);
    const res = await agentApprovalResolveHandler(
      { approvalId: "appr_1", decision: "approved" },
      CTX,
    );
    expect(mocks.updateMock).toHaveBeenCalledTimes(1);
    expect(mocks.setMock).toHaveBeenCalledTimes(1);
    const setArg = mocks.setMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(setArg.resolution).toBe("approved");
    // Guard clauses present in the WHERE.
    const sqlSeen = mocks.sqlArgsRecord.join("|");
    expect(sqlSeen).toMatch(/> now\(\)/);
    expect(sqlSeen).toMatch(/IS NULL/);
    expect(mocks.notifyResolutionMock).toHaveBeenCalledWith({
      approvalId: "appr_1",
      resolution: "approved",
      note: null,
    });
    expect(res).toEqual({ approvalId: "appr_1", resolution: "approved" });
  });

  it("returns expired when no rows are updated", async () => {
    mocks.returningMock.mockResolvedValueOnce([]);
    const res = await agentApprovalResolveHandler(
      { approvalId: "appr_2", decision: "approved" },
      CTX,
    );
    expect(res.resolution).toBe("expired");
    expect(mocks.notifyResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "appr_2", resolution: "expired" }),
    );
  });
});
