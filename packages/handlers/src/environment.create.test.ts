// environment.create handler: the role gate (#4194).
//
// The contract grants org Owner or Admin. The kernel's IAM check allows every
// capability for a non-enterprise org, so the handler is the only gate there,
// and it runs before the environment is written.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({ createEnvironment: vi.fn() }));

vi.mock("@oxagen/plugins", () => ({
  createEnvironment: mocks.createEnvironment,
}));

import { environmentCreateHandler } from "./environment.create";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { name: "Production", slug: "production" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.createEnvironment.mockResolvedValue({ id: "env_1" });
});

describe("environmentCreateHandler role gate", () => {
  it("refuses a workspace Member as forbidden and writes nothing", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(environmentCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.createEnvironment).not.toHaveBeenCalled();
  });

  it("refuses a workspace Owner, whom the contract does not name", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(environmentCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.createEnvironment).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin"])("allows an org %s", async (role) => {
    roleGate.roles = { org: role };
    await expect(environmentCreateHandler(INPUT, CTX)).resolves.toEqual({
      environment: { id: "env_1" },
    });
    expect(mocks.createEnvironment).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: CTX.userId },
      { name: "Production", slug: "production", description: null },
    );
  });

  it("acts as an API key's creator", async () => {
    roleGate.roles = { org: "Admin", keyCreator: "u_creator" };
    await expect(
      environmentCreateHandler(INPUT, {
        ...CTX,
        userId: null,
        apiKeyId: "key_1",
      }),
    ).resolves.toEqual({ environment: { id: "env_1" } });
  });
});
