// environment.update handler: the role gate (#4194).
//
// The contract grants org Owner or Admin. The kernel's IAM check allows every
// capability for a non-enterprise org, so the handler is the only gate there,
// and it runs before the environment is changed.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({ updateEnvironment: vi.fn() }));

vi.mock("@oxagen/plugins", () => ({ updateEnvironment: mocks.updateEnvironment }));

import { environmentUpdateHandler } from "./environment.update";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { environmentId: "env_1", name: "Staging" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.updateEnvironment.mockResolvedValue({ id: "env_1" });
});

describe("environmentUpdateHandler role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(environmentUpdateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.updateEnvironment).not.toHaveBeenCalled();
  });

  it("refuses a workspace Owner, whom the contract does not name", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(environmentUpdateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.updateEnvironment).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin"])("allows an org %s", async (role) => {
    roleGate.roles = { org: role };
    await expect(environmentUpdateHandler(INPUT, CTX)).resolves.toEqual({ environment: { id: "env_1" } });
    expect(mocks.updateEnvironment).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: CTX.userId },
      {
        environmentId: "env_1",
        name: "Staging",
        slug: undefined,
        description: undefined,
        isActive: undefined,
      },
    );
  });
});
