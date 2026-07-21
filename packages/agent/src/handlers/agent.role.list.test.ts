import { describe, expect, it, beforeEach, vi } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

import { agentRoleListHandler } from "./agent.role.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "agent-uuid",
  publicId: "agt_1",
  slug: "my-agent",
  principalId: "prn-agent",
};

beforeEach(() => fake.reset());

describe("agent.role.list handler", () => {
  it("lists active assignments with ISO timestamps", async () => {
    fake.enqueue(
      [AGENT_ROW], // agent select
      [
        {
          assignmentId: "pra_1",
          roleId: "rol_contrib",
          roleName: "Agent Contributor",
          scopeKind: "org",
          isSystemDefault: true,
          assignedAt: new Date("2026-07-01T12:00:00.000Z"),
          assignedBy: "u_1",
          expiresAt: null,
          workspaceId: null,
        },
        {
          assignmentId: "pra_2",
          roleId: "rol_custom",
          roleName: "Data Steward",
          scopeKind: "workspace",
          isSystemDefault: false,
          assignedAt: new Date("2026-06-01T12:00:00.000Z"),
          assignedBy: null,
          expiresAt: new Date("2027-01-01T00:00:00.000Z"),
          workspaceId: "ws_1",
        },
      ],
    );
    const out = await agentRoleListHandler({ agentId: "agt_1" }, CTX);
    expect(out.agentId).toBe("agt_1");
    expect(out.total).toBe(2);
    expect(out.roles[0]).toMatchObject({
      assignmentId: "pra_1",
      roleName: "Agent Contributor",
      assignedAt: "2026-07-01T12:00:00.000Z",
      expiresAt: null,
    });
    expect(out.roles[1]).toMatchObject({
      roleName: "Data Steward",
      expiresAt: "2027-01-01T00:00:00.000Z",
      workspaceId: "ws_1",
    });
  });

  it("returns an empty list for a pre-RBAC agent without a principal", async () => {
    fake.enqueue([{ ...AGENT_ROW, principalId: null }]);
    const out = await agentRoleListHandler({ agentId: "agt_1" }, CTX);
    expect(out.roles).toEqual([]);
    expect(out.total).toBe(0);
  });

  it("throws when the agent does not exist in this workspace", async () => {
    fake.enqueue([]);
    await expect(
      agentRoleListHandler({ agentId: "agt_missing" }, CTX),
    ).rejects.toThrow(/Agent not found/);
  });
});
