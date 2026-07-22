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

const { agentRoleRevokeHandler } = await import("./agent.role.revoke");
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

describe("agent.role.revoke handler", () => {
  it("throws when no authenticated user", async () => {
    await expect(
      agentRoleRevokeHandler(
        { agentId: "agt_1", roleId: "rol_1" },
        makeCTX({ userId: null }),
      ),
    ).rejects.toThrow(/authenticated user/);
  });

  it("throws when the agent is not found", async () => {
    fake.enqueue([]);
    await expect(
      agentRoleRevokeHandler(
        { agentId: "agt_missing", roleId: "rol_1" },
        makeCTX(),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("throws when the role is not found", async () => {
    fake.enqueue([AGENT_ROW], []);
    await expect(
      agentRoleRevokeHandler(
        { agentId: "agt_1", roleId: "rol_missing" },
        makeCTX(),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("revoked:true when a live assignment existed", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [{ id: "role-uuid" }],
      [{ id: "pra-1" }], // update .returning()
    );
    const out = await agentRoleRevokeHandler(
      { agentId: "agt_1", roleId: "rol_1" },
      makeCTX(),
    );
    expect(out).toMatchObject({
      revoked: true,
      agentId: "agt_1",
      roleId: "rol_1",
    });
  });

  it("revoked:false when no live assignment matched", async () => {
    fake.enqueue([AGENT_ROW], [{ id: "role-uuid" }], []);
    const out = await agentRoleRevokeHandler(
      { agentId: "agt_1", roleId: "rol_1" },
      makeCTX(),
    );
    expect(out.revoked).toBe(false);
  });
});
