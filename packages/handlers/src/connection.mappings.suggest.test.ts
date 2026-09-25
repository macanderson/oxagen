// connection.mappings.suggest handler: the role gate (#4194).
//
// The contract grants org Owner or Admin, or workspace Owner. A suggestion
// runs a model call the org pays for. The kernel's IAM check allows every
// capability for a non-enterprise org, so the handler is the only gate there,
// and it runs before the connection is read or the model is called.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  generateObjectFor: vi.fn(),
  selectModelForOrg: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
  selectModelForOrg: mocks.selectModelForOrg,
}));

import { connectionMappingsSuggestHandler } from "./connection.mappings.suggest";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = {
  connectionId: "con_1",
  recordTypes: [
    {
      sourceRecordType: "issue",
      displayName: "Issue",
      sampleFields: ["title"],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  // No connection row: an allowed caller stops at `Connection not found`.
  mocks.withTenantDb.mockResolvedValue([]);
});

describe("connectionMappingsSuggestHandler role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(
      connectionMappingsSuggestHandler(INPUT as never, CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it.each([
    ["an org Admin", { org: "Admin" }],
    ["a workspace Owner", { org: null, workspace: "Owner" }],
  ])("lets %s through to the connection lookup", async (_who, roles) => {
    roleGate.roles = roles;
    await expect(
      connectionMappingsSuggestHandler(INPUT as never, CTX),
    ).rejects.toThrow("Connection not found");
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});
