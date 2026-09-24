import { beforeEach, expect, it, vi } from "vitest";
import { runOutcomesSettingsSet } from "@oxagen/oxagen/contracts/run.outcomes.settings.set";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), viewer: vi.fn() }));
vi.mock("@oxagen/oxagen", async (original) => ({
  ...(await original<typeof import("@oxagen/oxagen")>()),
  invoke: mocks.invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (original) => ({
  ...(await original<typeof import("@/server/viewer")>()),
  requireViewer: mocks.viewer,
}));
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { setRunOutcomesConsentAction } = await import("./actions");
const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core",
  wsName: "Core",
  wsRole: "owner",
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewer.mockResolvedValue(ctx);
});
it("resolves the viewer and writes only the explicit customer choice through the kernel", async () => {
  const policy = {
    customerEnabled: true,
    platformDisabled: false,
    platformDisabledReason: null,
    effectiveEnabled: true,
  };
  mocks.invoke.mockResolvedValue(policy);
  expect(
    await setRunOutcomesConsentAction({ org: "acme", ws: "core" }, true),
  ).toEqual({ ok: true, value: policy });
  expect(mocks.viewer).toHaveBeenCalledWith("acme", "core");
  expect(mocks.invoke).toHaveBeenCalledWith(
    runOutcomesSettingsSet.name,
    { customerEnabled: true },
    expect.objectContaining({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }),
  );
});
