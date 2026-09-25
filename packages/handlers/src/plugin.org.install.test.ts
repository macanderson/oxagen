// plugin.org.install handler: the role gate (#4194).
//
// The contract grants org Owner or Admin, or workspace Owner or Admin.
// Installing a plugin adds MCP servers or capabilities to the workspace, so
// the kernel's IAM check, which allows every capability for a non-enterprise
// org, leaves the handler as the only gate there. It runs before the plugin
// is looked up or any row is read or written.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  getOxagenPlugin: vi.fn(),
  upsertCapabilityInstall: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withSystemDb: mocks.withSystemDb,
  };
});

vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));

vi.mock("@oxagen/oxagen/plugins", () => ({
  getOxagenPlugin: mocks.getOxagenPlugin,
}));

vi.mock("./capability-install", () => ({
  upsertCapabilityInstall: mocks.upsertCapabilityInstall,
}));

import { handler } from "./plugin.org.install";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { pluginType: "agent_capability", pluginId: "oxagen/unknown" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.getOxagenPlugin.mockReturnValue(undefined);
});

describe("plugin.org.install role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.getOxagenPlugin).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.upsertCapabilityInstall).not.toHaveBeenCalled();
  });

  it.each([
    ["an org Admin", { org: "Admin" }],
    ["a workspace Owner", { org: null, workspace: "Owner" }],
  ])("lets %s through to the plugin lookup", async (_who, roles) => {
    roleGate.roles = roles;
    await expect(handler(INPUT, CTX)).rejects.toThrow(
      /Unknown capability plugin/,
    );
    expect(mocks.getOxagenPlugin).toHaveBeenCalledWith("oxagen/unknown");
  });
});
