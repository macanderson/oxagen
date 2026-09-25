// environment.delete handler: the role gate (#4194).
//
// The contract grants org Owner or Admin. The kernel's IAM check allows every
// capability for a non-enterprise org, so the handler is the only gate there,
// and it runs before the environment is deleted.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({ deleteEnvironment: vi.fn() }));

vi.mock("@oxagen/plugins", () => ({ deleteEnvironment: mocks.deleteEnvironment }));

import { environmentDeleteHandler } from "./environment.delete";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { environmentId: "env_1" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.deleteEnvironment.mockResolvedValue({ ok: true });
});

describe("environmentDeleteHandler role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(environmentDeleteHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.deleteEnvironment).not.toHaveBeenCalled();
  });

  it("refuses a workspace Owner, whom the contract does not name", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(environmentDeleteHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.deleteEnvironment).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin"])("allows an org %s", async (role) => {
    roleGate.roles = { org: role };
    await expect(environmentDeleteHandler(INPUT, CTX)).resolves.toEqual({ ok: true });
    expect(mocks.deleteEnvironment).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: CTX.userId },
      { environmentId: "env_1" },
    );
  });
});
