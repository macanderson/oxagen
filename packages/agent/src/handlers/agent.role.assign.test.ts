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

vi.mock("@oxagen/billing", () => ({
  canAccessACL: (tier: string) => tier === "enterprise",
}));

const ceilingMock = vi.fn();
const assignerGrantsMock = vi.fn();
vi.mock("./_agent-role", () => ({
  resolveAssignerEffectiveGrants: (...args: unknown[]) =>
    assignerGrantsMock(...args),
  targetRoleExceedsAssignerGrants: (...args: unknown[]) => ceilingMock(...args),
}));

const { agentRoleAssignHandler } = await import("./agent.role.assign");
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

beforeEach(() => {
  fake.reset();
  ceilingMock.mockReset();
  assignerGrantsMock.mockReset();
  assignerGrantsMock.mockResolvedValue({
    isOwner: false,
    byCapability: new Map(),
  });
  ceilingMock.mockResolvedValue({ exceeds: false });
});

describe("agent.role.assign handler", () => {
  it("throws when no authenticated user", async () => {
    await expect(
      agentRoleAssignHandler(
        { agentId: "agt_1", roleId: "rol_1" },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]); // resolveAgent select
    await expect(
      agentRoleAssignHandler(
        { agentId: "agt_missing", roleId: "rol_1" },
        makeCTX(),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("rejects a CUSTOM role on a non-enterprise org (tier gating)", async () => {
    fake.enqueue(
      [AGENT_ROW], // resolveAgent
      [{ id: "role-uuid", name: "Custom Agent Role", isSystemDefault: false }], // roleRow
    );
    await expect(
      agentRoleAssignHandler(
        { agentId: "agt_1", roleId: "rol_custom" },
        makeCTX({ planTier: "build" }),
      ),
    ).rejects.toThrow(/enterprise plan/);
  });

  it("allows a CUSTOM role on an enterprise org", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ id: "role-uuid", name: "Custom Agent Role", isSystemDefault: false }],
      [], // existing assignment lookup — none
      [{ publicId: "pra_new" }], // insert returning
    );
    const out = await agentRoleAssignHandler(
      { agentId: "agt_1", roleId: "rol_custom" },
      makeCTX({ planTier: "enterprise" }),
    );
    expect(out.assignmentId).toBe("pra_new");
    expect(out.roleName).toBe("Custom Agent Role");
  });

  it("rejects when the target role exceeds the assigner's delegation ceiling", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ id: "role-uuid", name: "Agent Operator", isSystemDefault: true }],
    );
    ceilingMock.mockResolvedValue({
      exceeds: true,
      capability: "billing.export",
    });
    await expect(
      agentRoleAssignHandler(
        { agentId: "agt_1", roleId: "rol_operator" },
        makeCTX(),
      ),
    ).rejects.toThrow(/delegation ceiling/);
  });

  it("happy path: replaces an existing assignment and returns the new one", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ id: "role-uuid-2", name: "Agent Observer", isSystemDefault: true }],
      [{ id: "pra-old-id", roleId: "rol_contributor" }], // existing assignment found
      [], // soft-delete update (awaited, no meaningful result)
      [{ publicId: "pra_new_2" }], // insert returning
    );
    const out = await agentRoleAssignHandler(
      { agentId: "agt_1", roleId: "rol_observer" },
      makeCTX(),
    );
    expect(out).toMatchObject({
      assignmentId: "pra_new_2",
      agentId: "agt_1",
      roleId: "rol_observer",
      roleName: "Agent Observer",
      previousRoleId: "rol_contributor",
    });
    expect(fake.mutations.insert).toBeGreaterThan(0);
    expect(fake.mutations.update).toBeGreaterThan(0); // soft-delete of the old assignment
  });
});
