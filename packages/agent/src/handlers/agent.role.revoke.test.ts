import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

const mocks = vi.hoisted(() => ({
  emitAudit: vi.fn(async (_args: unknown) => undefined),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
});

vi.mock("@oxagen/iam", () => ({
  emitAudit: mocks.emitAudit,
}));

import { agentRoleRevokeHandler } from "./agent.role.revoke";
import {
  AgentPrincipalMissingError,
  AgentRoleNotFoundError,
} from "./_agent-role";
import { TEST_CTX as CTX, makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "agent-uuid",
  publicId: "agt_1",
  slug: "my-agent",
  principalId: "prn-agent",
};

const ROLE_ROW = {
  id: "role-contrib",
  publicId: "rol_contrib",
  name: "Agent Contributor",
  scopeKind: "org",
  isSystemDefault: true,
};

const INPUT = { agentId: "agt_1", roleName: "Agent Contributor" };

beforeEach(() => {
  fake.reset();
  mocks.emitAudit.mockClear();
});

describe("agent.role.revoke handler", () => {
  it("soft-deletes the active assignment and audits with principal_kind='agent'", async () => {
    fake.enqueue(
      [AGENT_ROW], // agent select
      [ROLE_ROW], // role select
      [{ id: "pra-1" }], // update … returning (one row revoked)
    );
    const out = await agentRoleRevokeHandler(INPUT, CTX);
    expect(out.revoked).toBe(true);
    expect(out.agentId).toBe("agt_1");
    expect(fake.mutations.update).toBe(1);
    expect(fake.mutations.delete).toBe(0); // soft delete, never a hard DELETE
    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
    const args = mocks.emitAudit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.capability).toBe("revoke_agent_role");
    expect(args.principal).toMatchObject({ id: "prn-agent", kind: "agent" });
    expect(args.target).toEqual({ kind: "agent", id: "agt_1" });
  });

  it("is idempotent: revoking an unheld role returns revoked=false and does not audit", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [ROLE_ROW],
      [], // update … returning nothing
    );
    const out = await agentRoleRevokeHandler(INPUT, CTX);
    expect(out.revoked).toBe(false);
    expect(mocks.emitAudit).not.toHaveBeenCalled();
  });

  it("throws AgentRoleNotFoundError for an unknown role name", async () => {
    fake.enqueue([AGENT_ROW], []);
    const err = await agentRoleRevokeHandler(INPUT, CTX).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentRoleNotFoundError);
  });

  it("throws AgentPrincipalMissingError for a pre-RBAC agent", async () => {
    fake.enqueue([{ ...AGENT_ROW, principalId: null }]);
    const err = await agentRoleRevokeHandler(INPUT, CTX).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentPrincipalMissingError);
  });

  it("rejects an unauthenticated call", async () => {
    await expect(
      agentRoleRevokeHandler(INPUT, makeCTX({ userId: null, apiKeyId: null })),
    ).rejects.toThrow(/Unauthorized/);
  });
});
