import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  actor: vi.fn(),
  operation: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
}));
vi.mock("@oxagen/plugins/run-outcomes-linear", () => ({
  completeLinearAuthorization: mocks.operation,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.audit,
}));
import { handler } from "./run.issue.authorization.complete";
const ctx: CapabilityContext = {
  orgId: "org",
  workspaceId: "workspace",
  userId: "user",
  apiKeyId: null,
  surface: "api",
  messageId: null,
  requestId: "test-request",
};
const input = { state: "a".repeat(43), code: "code" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue("user");
  mocks.role.mockResolvedValue(undefined);
  mocks.operation.mockResolvedValue({ connectionId: "con_new" });
  mocks.audit.mockResolvedValue(undefined);
});
describe("complete issue authorization", () => {
  it("refuses a non-admin before provider effects", async () => {
    mocks.role.mockRejectedValue(new Error("forbidden"));
    await expect(handler(input, ctx)).rejects.toThrow("forbidden");
    expect(mocks.operation).not.toHaveBeenCalled();
  });
  it("binds provider authorization to the verified actor and context scope", async () => {
    await handler(input, ctx);
    expect(mocks.role).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user" }),
      { org: ["Owner", "Admin"] },
    );
    expect(mocks.operation).toHaveBeenCalledWith(
      { orgId: "org", workspaceId: "workspace" },
      "user",
      input.state,
      input.code,
    );
  });
});
it("awaits the credential audit and includes no token material", async () => {
  await handler(input, ctx);
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: "plugin.credential_set",
      detail: {
        feature: "run_outcomes",
        provider: "linear",
        connectionId: "con_new",
      },
    }),
  );
  mocks.audit.mockRejectedValue(new Error("audit unavailable"));
  await expect(handler(input, ctx)).rejects.toThrow("audit unavailable");
});
