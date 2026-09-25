// agent.environment.bind handler: the role gate (#4194).
//
// The contract grants org Owner or Admin. The kernel's IAM check allows every
// capability for a non-enterprise org, so the handler is the only gate there,
// and it runs before the agent is bound to the environment's secrets.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({ bindAgentEnvironment: vi.fn() }));

vi.mock("@oxagen/plugins", () => ({ bindAgentEnvironment: mocks.bindAgentEnvironment }));

import { agentEnvironmentBindHandler } from "./agent.environment.bind";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { agentId: "agt_1", environmentId: "env_1" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  mocks.bindAgentEnvironment.mockResolvedValue({ id: "bind_1" });
});

describe("agentEnvironmentBindHandler role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(agentEnvironmentBindHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.bindAgentEnvironment).not.toHaveBeenCalled();
  });

  it("refuses a workspace Owner, whom the contract does not name", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(agentEnvironmentBindHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.bindAgentEnvironment).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin"])("allows an org %s", async (role) => {
    roleGate.roles = { org: role };
    await expect(agentEnvironmentBindHandler(INPUT, CTX)).resolves.toEqual({ binding: { id: "bind_1" } });
    expect(mocks.bindAgentEnvironment).toHaveBeenCalledWith(
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, userId: CTX.userId },
      INPUT,
    );
  });
});
