import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ write: vi.fn(), audit: vi.fn() }));
vi.mock("@oxagen/plugins/run-outcomes-policy", () => ({
  setRunOutcomesPlatformAccess: mocks.write,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.audit,
}));
import { runOutcomesAccessSetHandler } from "./run.outcomes.access.set";
import { runOutcomesAccessSet } from "@oxagen/oxagen/contracts/run.outcomes.access.set";
import type { CapabilityContext } from "@oxagen/oxagen";
const ctx: CapabilityContext = {
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  surface: "runner",
  messageId: null,
  requestId: "operator-1",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.write.mockResolvedValue({
    customerEnabled: true,
    platformDisabled: true,
    platformDisabledReason: "Review required",
    effectiveEnabled: false,
  });
  mocks.audit.mockResolvedValue(undefined);
});
it("declares a platform-only boundary with no public surface", () => {
  expect(runOutcomesAccessSet.platformOnly).toBe(true);
  expect(runOutcomesAccessSet.surfaces).toEqual([]);
  expect(
    runOutcomesAccessSet.input.safeParse({
      orgId: "11111111-1111-4111-8111-111111111111",
      disabled: true,
      reason: " ",
    }).success,
  ).toBe(false);
});
it("records the target organization and reason and propagates audit failure", async () => {
  const input = {
    orgId: "target-org",
    disabled: true,
    reason: "Review required",
  };
  await runOutcomesAccessSetHandler(input, ctx);
  expect(mocks.write).toHaveBeenCalledWith({
    ...input,
    requestId: "operator-1",
  });
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      orgId: "target-org",
      requestId: "operator-1",
      capability: "set_run_outcomes_access",
      detail: {
        feature: "run_outcomes",
        change: "platform_access",
        enabled: false,
        reason: "Review required",
      },
    }),
  );
  mocks.audit.mockRejectedValue(new Error("audit unavailable"));
  await expect(runOutcomesAccessSetHandler(input, ctx)).rejects.toThrow(
    "audit unavailable",
  );
});
