import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  actor: vi.fn(),
  consent: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
}));
vi.mock("@oxagen/plugins/run-outcomes-policy", () => ({
  setRunOutcomesConsent: mocks.consent,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.audit,
}));
import { runOutcomesSettingsSetHandler } from "./run.outcomes.settings.set";
import type { CapabilityContext } from "@oxagen/oxagen";
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
  mocks.role.mockResolvedValue(undefined);
  mocks.consent.mockResolvedValue({
    customerEnabled: true,
    platformDisabled: false,
    platformDisabledReason: null,
    effectiveEnabled: true,
  });
  mocks.audit.mockResolvedValue(undefined);
});
describe("explicit run outcomes consent", () => {
  it("refuses a member before changing consent", async () => {
    mocks.role.mockRejectedValue(new Error("forbidden"));
    await expect(
      runOutcomesSettingsSetHandler({ customerEnabled: true }, ctx),
    ).rejects.toThrow("forbidden");
    expect(mocks.consent).not.toHaveBeenCalled();
  });
  it("requires Owner/Admin, stores the acting person, and awaits audit", async () => {
    await runOutcomesSettingsSetHandler({ customerEnabled: true }, ctx);
    expect(mocks.role).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
      { org: ["Owner", "Admin"] },
    );
    expect(mocks.consent).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      true,
      "user-1",
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "set_run_outcomes_settings",
        detail: {
          feature: "run_outcomes",
          change: "customer_consent",
          enabled: true,
          reason: null,
        },
      }),
    );
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(
      runOutcomesSettingsSetHandler({ customerEnabled: false }, ctx),
    ).rejects.toThrow("audit unavailable");
  });
});
