// environment.set_default handler: the role gate (#4194).
//
// The contract grants org Owner or Admin. The kernel's IAM check allows every
// capability for a non-enterprise org, so the handler is the only gate there,
// and it runs before the workspace's default environment changes.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({ setDefaultEnvironment: vi.fn() }));

vi.mock("@oxagen/plugins", () => ({ setDefaultEnvironment: mocks.setDefaultEnvironment }));

import { environmentSetDefaultHandler } from "./environment.set_default";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { environmentId: "env_1" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.setDefaultEnvironment.mockResolvedValue({ id: "env_1" });
});

describe("environmentSetDefaultHandler role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(environmentSetDefaultHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.setDefaultEnvironment).not.toHaveBeenCalled();
  });

  it("refuses a workspace Owner, whom the contract does not name", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(environmentSetDefaultHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.setDefaultEnvironment).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin"])("allows an org %s", async (role) => {
    roleGate.roles = { org: role };
    await expect(environmentSetDefaultHandler(INPUT, CTX)).resolves.toEqual({ environment: { id: "env_1" } });
    expect(mocks.setDefaultEnvironment).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: CTX.userId },
      { environmentId: "env_1" },
    );
  });
});
