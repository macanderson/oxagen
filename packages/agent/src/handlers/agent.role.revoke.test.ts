import { withTransactionOrgScope } from "@oxagen/database";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeTx } from "../test-utils/fake-tx";

const fake = createFakeTx();

const mocks = vi.hoisted(() => ({
  emitAudit: vi.fn(async (_args: unknown) => undefined),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTransactionOrgScope: vi.fn(
      async (tx: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    ),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake.tx),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/iam", () => ({
  emitAudit: mocks.emitAudit,
}));

// The role gate reads iam.principal_role_assignments and the key's creator
// from auth.api_keys; the tests decide both. role-check.test.ts in
// packages/handlers pins the call shape.
const gate = vi.hoisted(() => ({
  keyCreator: "u_creator" as string | null,
  orgRole: "Owner" as string | null,
  calls: [] as { userId: string | null; org: readonly string[] }[],
}));
vi.mock("@oxagen/iam/org-role", async () => {
  const { HandlerError } = await import("@oxagen/oxagen");
  return {
    resolveActingUserId: async (c: {
      userId: string | null;
      apiKeyId: string | null;
    }) => c.userId ?? (c.apiKeyId ? gate.keyCreator : null),
    assertOrgRole: async (
      actor: { userId: string | null },
      required: { org: readonly string[] },
    ) => {
      gate.calls.push({ userId: actor.userId, org: required.org });
      if (!actor.userId) {
        throw new HandlerError({
          code: "forbidden",
          reason: "no_principal",
          message: "No signed-in user on the request",
        });
      }
      if (gate.orgRole === null || !required.org.includes(gate.orgRole)) {
        throw new HandlerError({
          code: "forbidden",
          reason: "org_role_required",
          message: `Requires one of the org roles ${required.org.join(", ")}`,
        });
      }
      return gate.orgRole;
    },
  };
});

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
  vi.mocked(withTransactionOrgScope).mockClear();
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
    expect(withTransactionOrgScope).toHaveBeenCalledWith(
      fake.tx,
      expect.any(Function),
    );
    expect(fake.mutations.delete).toBe(0); // soft delete, never a hard DELETE
    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
    const args = mocks.emitAudit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.capability).toBe("revoke_agent_role");
    expect(args.principal).toMatchObject({ id: "prn-agent", kind: "agent" });
    expect(args.target).toEqual({ kind: "agent", id: "agt_1" });
  });

  it("still removes a role from a retired (archived) agent", async () => {
    // assign_agent_role refuses a retired agent. Removing a role it still
    // holds only narrows what the suspended principal could do.
    fake.enqueue(
      [{ ...AGENT_ROW, status: "archived" }],
      [ROLE_ROW],
      [{ id: "pra-1" }],
    );
    const out = await agentRoleRevokeHandler(INPUT, CTX);
    expect(out.revoked).toBe(true);
    expect(fake.mutations.update).toBe(1);
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
});

describe("agent.role.revoke — role gate (org Owner or Admin)", () => {
  const forbidden = (reason: string) => ({ code: "forbidden", reason });

  beforeEach(() => {
    gate.keyCreator = "u_creator";
    gate.orgRole = "Owner";
    gate.calls = [];
  });

  it("gates the signed-in user on org Owner or Admin", async () => {
    fake.enqueue([AGENT_ROW], [ROLE_ROW], [{ id: "pra-1" }]);
    await agentRoleRevokeHandler(INPUT, CTX);
    expect(gate.calls).toEqual([{ userId: "u_1", org: ["Owner", "Admin"] }]);
  });

  it("refuses an org Member before any query, and writes and audits nothing (negative)", async () => {
    gate.orgRole = "Member";
    await expect(agentRoleRevokeHandler(INPUT, CTX)).rejects.toMatchObject(
      forbidden("org_role_required"),
    );
    expect(fake.mutations.update).toBe(0);
    expect(mocks.emitAudit).not.toHaveBeenCalled();
  });

  it("refuses a call with no user and no API key with no_principal (negative)", async () => {
    await expect(
      agentRoleRevokeHandler(INPUT, makeCTX({ userId: null, apiKeyId: null })),
    ).rejects.toMatchObject(forbidden("no_principal"));
    expect(fake.mutations.update).toBe(0);
  });

  describe("an API-key call acts as the key's creator", () => {
    const KEY_CTX = makeCTX({ userId: null, apiKeyId: "aky_1" });

    it("revokes for a creator who is an org Admin", async () => {
      gate.orgRole = "Admin";
      fake.enqueue([AGENT_ROW], [ROLE_ROW], [{ id: "pra-1" }]);
      const out = await agentRoleRevokeHandler(INPUT, KEY_CTX);
      expect(out.revoked).toBe(true);
      expect(gate.calls).toEqual([
        { userId: "u_creator", org: ["Owner", "Admin"] },
      ]);
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      gate.orgRole = "Member";
      await expect(
        agentRoleRevokeHandler(INPUT, KEY_CTX),
      ).rejects.toMatchObject(forbidden("org_role_required"));
      expect(fake.mutations.update).toBe(0);
    });

    it("refuses a key with no creator (negative)", async () => {
      gate.keyCreator = null;
      await expect(
        agentRoleRevokeHandler(INPUT, KEY_CTX),
      ).rejects.toMatchObject(forbidden("no_principal"));
      expect(fake.mutations.update).toBe(0);
    });
  });
});
