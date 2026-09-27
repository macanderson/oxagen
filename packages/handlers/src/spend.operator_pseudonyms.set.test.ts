import type { CapabilityContext } from "@oxagen/oxagen";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  actor: vi.fn(),
  write: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
}));
vi.mock("./lib/operator-pseudonyms", () => ({
  writePseudonymPolicy: mocks.write,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.audit,
}));

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
  mocks.actor.mockResolvedValue("user-1");
  mocks.role.mockResolvedValue("Owner");
  mocks.write.mockImplementation(async (_scope, enabled: boolean) => ({
    pseudonyms: enabled,
  }));
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
      { orgId: "org-1", workspaceId: "ws-1" },
      true,
      "user-1",
    );
  });

  it("records each change as a security event and fails when the record fails", async () => {
    await spendOperatorPseudonymsSetHandler({ enabled: false }, ctx);
    expect(mocks.audit).toHaveBeenCalledWith(
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
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(
      spendOperatorPseudonymsSetHandler({ enabled: true }, ctx),
    ).rejects.toThrow("audit unavailable");
  });
});
