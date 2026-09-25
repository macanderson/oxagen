// plugin.registry.add handler: the role gate (#4194).
//
// The contract grants org Owner or Admin, or workspace Owner. A registry is
// where the workspace's MCP servers come from, so a Member who could add one
// could point the workspace at an untrusted source. The kernel's IAM check
// allows every capability for a non-enterprise org, so the handler is the
// only gate there, and it runs before the registry row is written.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  addRegistry: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("./registry-default", () => ({ addRegistry: mocks.addRegistry }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { handler } from "./plugin.registry.add";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { name: "Acme", baseUrl: "https://registry.example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({}),
  );
  mocks.addRegistry.mockResolvedValue({ id: "reg_1", isDefault: false });
});

describe("plugin.registry.add role gate", () => {
  it("refuses a workspace Member as forbidden and adds nothing", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.addRegistry).not.toHaveBeenCalled();
  });

  it.each([
    ["an org Admin", { org: "Admin" }],
    ["a workspace Owner", { org: null, workspace: "Owner" }],
  ])("allows %s", async (_who, roles) => {
    roleGate.roles = roles;
    await expect(handler(INPUT, CTX)).resolves.toEqual({
      registryId: "reg_1",
      isDefault: false,
    });
    expect(mocks.addRegistry).toHaveBeenCalledWith(
      {},
      {
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        name: "Acme",
        baseUrl: "https://registry.example.com",
      },
    );
  });
});
