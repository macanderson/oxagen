// plugin.registry.remove handler: the role gate (#4194).
//
// The contract grants org Owner or Admin, or workspace Owner. The kernel's
// IAM check allows every capability for a non-enterprise org, so the handler
// is the only gate there, and it runs before the registry row is removed.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  removeRegistry: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("./registry-default", () => ({ removeRegistry: mocks.removeRegistry }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { handler } from "./plugin.registry.remove";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { registryId: "reg_1" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({}),
  );
  mocks.removeRegistry.mockResolvedValue({ removed: true, promotedId: null });
});

describe("plugin.registry.remove role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.removeRegistry).not.toHaveBeenCalled();
  });

  it.each([
    ["an org Admin", { org: "Admin" }],
    ["a workspace Owner", { org: null, workspace: "Owner" }],
  ])("allows %s", async (_who, roles) => {
    roleGate.roles = roles;
    await expect(handler(INPUT, CTX)).resolves.toEqual({
      ok: true,
      promotedId: null,
    });
    expect(mocks.removeRegistry).toHaveBeenCalledWith(
      {},
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, registryId: "reg_1" },
    );
  });
});
