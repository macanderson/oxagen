import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

const { agentRoleListHandler } = await import("./agent.role.list");
const { agentRoleGetHandler } = await import("./agent.role.get");
import { makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "agent-uuid-1",
  publicId: "agt_1",
  slug: "my-agent",
  name: "My Agent",
  description: null,
  agentType: "custom",
  status: "draft",
  deploymentStatus: "inactive",
  activeVersionId: null,
  avatarUrl: null,
  summary: null,
  summaryChecksum: null,
  principalId: "principal-1",
};

beforeEach(() => fake.reset());

describe("agent.role.list handler", () => {
  it("throws when the agent is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentRoleListHandler({ agentId: "agt_missing" }, makeCTX()),
    ).rejects.toThrow(/not found/);
  });

  it("returns an empty list when the agent has no principal", async () => {
    fake.enqueue([{ ...AGENT_ROW, principalId: null }]);
    const out = await agentRoleListHandler({ agentId: "agt_1" }, makeCTX());
    expect(out.assignments).toEqual([]);
  });

  it("returns active assignments", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [
        {
          assignmentId: "pra_1",
          roleId: "rol_contributor",
          roleName: "Agent Contributor",
          isSystemDefault: true,
          workspaceId: null,
          assignedAt: new Date("2026-01-01T00:00:00Z"),
          expiresAt: null,
        },
      ],
    );
    const out = await agentRoleListHandler({ agentId: "agt_1" }, makeCTX());
    expect(out.assignments).toHaveLength(1);
    expect(out.assignments[0]).toMatchObject({
      assignmentId: "pra_1",
      roleName: "Agent Contributor",
      isSystemDefault: true,
    });
  });
});

describe("agent.role.get handler", () => {
  it("returns assignment:null when the agent is not found -- actually throws", async () => {
    fake.enqueue([]);
    await expect(
      agentRoleGetHandler(
        { agentId: "agt_missing", roleId: "rol_1" },
        makeCTX(),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("returns assignment:null when the role does not exist", async () => {
    fake.enqueue([AGENT_ROW], []);
    const out = await agentRoleGetHandler(
      { agentId: "agt_1", roleId: "rol_missing" },
      makeCTX(),
    );
    expect(out.assignment).toBeNull();
  });

  it("returns assignment:null when the agent does not hold the role", async () => {
    fake.enqueue([AGENT_ROW], [{ id: "role-uuid" }], []);
    const out = await agentRoleGetHandler(
      { agentId: "agt_1", roleId: "rol_1" },
      makeCTX(),
    );
    expect(out.assignment).toBeNull();
  });

  it("returns the assignment when found", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ id: "role-uuid" }],
      [
        {
          assignmentId: "pra_1",
          roleId: "rol_1",
          roleName: "Agent Operator",
          isSystemDefault: true,
          workspaceId: null,
          assignedAt: new Date("2026-01-01T00:00:00Z"),
          expiresAt: null,
        },
      ],
    );
    const out = await agentRoleGetHandler(
      { agentId: "agt_1", roleId: "rol_1" },
      makeCTX(),
    );
    expect(out.assignment).toMatchObject({
      assignmentId: "pra_1",
      roleName: "Agent Operator",
    });
  });
});
