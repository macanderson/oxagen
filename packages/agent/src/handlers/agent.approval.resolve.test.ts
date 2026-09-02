import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  returningMock: vi.fn(),
  whereMock: vi.fn(),
  setMock: vi.fn(),
  updateMock: vi.fn(),
  sqlArgsRecord: [] as string[],
  notifyResolutionMock: vi.fn(async () => undefined),
}));

mocks.whereMock.mockImplementation(() => ({ returning: mocks.returningMock }));
mocks.setMock.mockImplementation(() => ({ where: mocks.whereMock }));
mocks.updateMock.mockImplementation(() => ({ set: mocks.setMock }));

const fakeApprovalResolveDb = { update: mocks.updateMock };
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeApprovalResolveDb,
    withTenantDb: async (
      fn: (tx: typeof fakeApprovalResolveDb) => Promise<unknown>,
    ) => fn(fakeApprovalResolveDb),
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...orig,
    sql: Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        mocks.sqlArgsRecord.push(strings.join("?"));
        return orig.sql(strings, ...values);
      },
      orig.sql,
    ) as typeof orig.sql,
  };
});

vi.mock("../runtime/approval", () => ({
  notifyResolution: mocks.notifyResolutionMock,
}));

import { agentApprovalResolveHandler } from "./agent.approval.resolve";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.approval.resolve handler", () => {
  beforeEach(() => {
    mocks.returningMock.mockReset();
    mocks.updateMock.mockClear();
    mocks.setMock.mockClear();
    mocks.whereMock.mockClear();
    mocks.notifyResolutionMock.mockClear();
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
