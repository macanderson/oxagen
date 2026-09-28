import type { CapabilityContext } from "@oxagen/oxagen";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  actor: vi.fn(),
  write: vi.fn(),
  audit: vi.fn(),
  transactions: [] as Array<{ tx: object; outcome: "commit" | "rollback" }>,
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
}));
vi.mock("./lib/operator-pseudonyms", () => ({
  writePseudonymPolicyIn: mocks.write,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventIn: mocks.audit,
}));
// A transaction fake: each call hands the callback its own tx object and
// records whether the callback returned (commit) or threw (rollback). The
// role gate reads through withOrgDb (ADR-086), so it gets the same fake.
vi.mock("@oxagen/database", () => {
  const transaction = async (fn: (tx: object) => Promise<unknown>) => {
    const entry = { tx: {}, outcome: "commit" as "commit" | "rollback" };
    mocks.transactions.push(entry);
    try {
      return await fn(entry.tx);
    } catch (err) {
      entry.outcome = "rollback";
      throw err;
    }
  };
  return { withTenantDb: transaction, withOrgDb: transaction };
});

import { spendOperatorPseudonymsSetHandler } from "./spend.operator_pseudonyms.set";

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  surface: "api",
  messageId: null,
  requestId: "test-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactions.length = 0;
  mocks.actor.mockResolvedValue("user-1");
  mocks.role.mockResolvedValue("Owner");
  mocks.write.mockImplementation(
    async (_tx: object, _scope: object, enabled: boolean) => ({
      pseudonyms: enabled,
    }),
  );
  mocks.audit.mockResolvedValue(undefined);
});

describe("set_operator_pseudonyms", () => {
  it("refuses a caller without the role before writing", async () => {
    mocks.role.mockRejectedValue(new Error("forbidden"));
    await expect(
      spendOperatorPseudonymsSetHandler({ enabled: true }, ctx),
    ).rejects.toThrow("forbidden");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("requires an org Owner or Admin and gives the gate the acting person", async () => {
    await spendOperatorPseudonymsSetHandler({ enabled: true }, ctx);
    expect(mocks.role).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      { org: ["Owner", "Admin"] },
    );
  });

  it("writes the setting for the caller's workspace with the acting person", async () => {
    const out = await spendOperatorPseudonymsSetHandler({ enabled: true }, ctx);
    expect(out).toEqual({ pseudonyms: true });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.anything(),
      { orgId: "org-1", workspaceId: "ws-1" },
      true,
      "user-1",
    );
  });

  it("records each change as a security event in the setting's transaction", async () => {
    await spendOperatorPseudonymsSetHandler({ enabled: false }, ctx);
    expect(mocks.transactions).toHaveLength(1);
    const [only] = mocks.transactions;
    expect(only?.outcome).toBe("commit");
    expect(mocks.write.mock.calls[0]?.[0]).toBe(only?.tx);
    expect(mocks.audit).toHaveBeenCalledWith(
      only?.tx,
      expect.objectContaining({
        capability: "set_operator_pseudonyms",
        actorUserId: "user-1",
        detail: {
          feature: "operator_ranking",
          change: "pseudonyms",
          enabled: false,
        },
      }),
    );
  });

  it("rolls the setting back when its security event cannot be written", async () => {
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(
      spendOperatorPseudonymsSetHandler({ enabled: true }, ctx),
    ).rejects.toThrow("audit unavailable");
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.transactions).toHaveLength(1);
    expect(mocks.transactions[0]?.outcome).toBe("rollback");
    expect(mocks.write.mock.calls[0]?.[0]).toBe(mocks.transactions[0]?.tx);
  });
});
