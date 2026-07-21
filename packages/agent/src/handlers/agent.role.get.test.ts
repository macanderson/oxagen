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

import { agentRoleGetHandler } from "./agent.role.get";
import { AgentRoleNotFoundError } from "./_agent-role";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "agent-uuid",
  publicId: "agt_1",
  slug: "my-agent",
  principalId: "prn-agent",
};

const ROLE_ROW = {
  id: "role-obs",
  publicId: "rol_obs",
  name: "Agent Observer",
  scopeKind: "org",
  isSystemDefault: true,
};

const INPUT = { agentId: "agt_1", roleName: "Agent Observer" };

beforeEach(() => fake.reset());

describe("agent.role.get handler", () => {
  it("returns the active assignment plus the role's grant list", async () => {
    fake.enqueue(
      [AGENT_ROW], // agent select
      [ROLE_ROW], // role select
      [
        {
          assignmentId: "pra_9",
          assignedAt: new Date("2026-07-10T09:00:00.000Z"),
          assignedBy: "u_1",
          expiresAt: null,
          workspaceId: null,
        },
      ], // assignment select
      [
        { capability: "recall_memory", effect: "allow" },
        { capability: "create_agent_def", effect: "deny" },
      ], // role grants
    );
    const out = await agentRoleGetHandler(INPUT, CTX);
    expect(out.assigned).toBe(true);
    expect(out.roleId).toBe("rol_obs");
    expect(out.assignment).toMatchObject({
      assignmentId: "pra_9",
      roleName: "Agent Observer",
      assignedAt: "2026-07-10T09:00:00.000Z",
    });
    expect(out.grants).toEqual([
      { capability: "recall_memory", effect: "allow" },
      { capability: "create_agent_def", effect: "deny" },
    ]);
  });

  it("reports assigned=false with a null assignment when the agent does not hold the role", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [ROLE_ROW],
      [], // no assignment
      [{ capability: "recall_memory", effect: "allow" }],
    );
    const out = await agentRoleGetHandler(INPUT, CTX);
    expect(out.assigned).toBe(false);
    expect(out.assignment).toBeNull();
    expect(out.grants).toHaveLength(1);
  });

  it("skips the assignment lookup for a pre-RBAC agent without a principal", async () => {
    fake.enqueue(
      [{ ...AGENT_ROW, principalId: null }],
      [ROLE_ROW],
      [], // role grants (assignment select is skipped)
    );
    const out = await agentRoleGetHandler(INPUT, CTX);
    expect(out.assigned).toBe(false);
    expect(out.assignment).toBeNull();
  });

  it("throws AgentRoleNotFoundError for an unknown role name", async () => {
    fake.enqueue([AGENT_ROW], []);
    const err = await agentRoleGetHandler(INPUT, CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRoleNotFoundError);
    expect((err as AgentRoleNotFoundError).code).toBe("agent_role_not_found");
  });
});
