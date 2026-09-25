// plugin.set_enabled handler: the role gate (#4194).
//
// The contract grants org Owner or Admin, or workspace Owner or Admin. The
// kernel's IAM check allows every capability for a non-enterprise org, so the
// handler is the only gate there, and it runs before the listing is read or
// switched.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: vi.fn() }));

import { handler } from "./plugin.set_enabled";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { scope: "org", orgListingId: "lst_1", enabled: false };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.withTenantDb.mockRejectedValue(new Error("stop after the gate"));
});

describe("plugin.set_enabled role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it.each([
    ["an org Admin", { org: "Admin" }],
    ["a workspace Owner", { org: null, workspace: "Owner" }],
  ])("lets %s through to the listing", async (_who, roles) => {
    roleGate.roles = roles;
    await expect(handler(INPUT, CTX)).rejects.toThrow("stop after the gate");
    expect(mocks.withTenantDb).toHaveBeenCalled();
  });
});
