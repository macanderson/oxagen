import { expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/plugins/run-outcomes-policy", () => ({
  readRunOutcomesPolicy: read,
}));
import { runOutcomesSettingsGetHandler } from "./run.outcomes.settings.get";
import { runOutcomesSettingsGet } from "@oxagen/oxagen/contracts/run.outcomes.settings.get";
import type { CapabilityContext } from "@oxagen/oxagen";
it("takes the organization from context, never a caller-selected target", async () => {
  expect(
    runOutcomesSettingsGet.input.safeParse({ orgId: "foreign" }).success,
  ).toBe(false);
  expect(runOutcomesSettingsGet.noBillingGate).toBe(true);
  const ctx: CapabilityContext = {
    orgId: "own-org",
    workspaceId: "own-ws",
    userId: "user-1",
    apiKeyId: null,
    surface: "api",
    messageId: null,
    requestId: "test-1",
  };
  const policy = {
    customerEnabled: false,
    platformDisabled: true,
    platformDisabledReason: "Review required",
    effectiveEnabled: false,
  };
  read.mockResolvedValue(policy);
  expect(await runOutcomesSettingsGetHandler({}, ctx)).toEqual(policy);
  expect(read).toHaveBeenCalledWith({
    orgId: "own-org",
    workspaceId: "own-ws",
  });
});
