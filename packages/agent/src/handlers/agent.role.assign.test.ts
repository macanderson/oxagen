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

import { agentRoleAssignHandler } from "./agent.role.assign";
import {
  AgentPrincipalMissingError,
  AgentRoleCeilingExceededError,
  AgentRoleNotAssignableError,
  AgentRoleNotFoundError,
} from "./_agent-role";
import { TierDeniedError } from "@oxagen/billing";
import { makeCTX } from "../test-utils/fixtures";

const AGENT_ROW = {
  id: "agent-uuid",
  publicId: "agt_1",
  slug: "my-agent",
  principalId: "prn-agent",
};

const SYSTEM_ROLE = {
  id: "role-contrib",
  publicId: "rol_contrib",
  name: "Agent Contributor",
  scopeKind: "org",
  isSystemDefault: true,
};

const CUSTOM_ROLE = {
  id: "role-custom",
  publicId: "rol_custom",
  name: "Data Steward",
  scopeKind: "org",
  isSystemDefault: false,
};

const INPUT = { agentId: "agt_1", roleName: "Agent Contributor" };

// planTier on ctx keeps resolveOrgTier (a DB read) out of the picture.
const CTX_BUILD = makeCTX({ planTier: "build" });
const CTX_ENTERPRISE = makeCTX({ planTier: "enterprise" });

beforeEach(() => {
  fake.reset();
  mocks.emitAudit.mockClear();
});

describe("agent.role.assign handler", () => {
  it("assigns a system agent role at a non-enterprise tier (no ceiling queries)", async () => {
    fake.enqueue(
      [AGENT_ROW], // agent select
      [SYSTEM_ROLE], // role select
      [], // existing assignment select
      [], // pra insert
    );
    const out = await agentRoleAssignHandler(INPUT, CTX_BUILD);
    expect(out.assigned).toBe(true);
    expect(out.alreadyAssigned).toBe(false);
    expect(out.agentId).toBe("agt_1");
    expect(out.roleId).toBe("rol_contrib");
    expect(fake.mutations.insert).toBe(1);
  });

  it("emits the IAM audit event with principal_kind='agent' and the agent as target", async () => {
    fake.enqueue([AGENT_ROW], [SYSTEM_ROLE], [], []);
    await agentRoleAssignHandler(INPUT, CTX_BUILD);
    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
    const args = mocks.emitAudit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.capability).toBe("assign_agent_role");
    expect(args.principal).toMatchObject({ id: "prn-agent", kind: "agent" });
    expect(args.target).toEqual({ kind: "agent", id: "agt_1" });
  });

  it("returns alreadyAssigned without writing or auditing when the active assignment exists", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [SYSTEM_ROLE],
      [{ id: "pra-1", deletedAt: null }], // existing ACTIVE assignment
    );
    const out = await agentRoleAssignHandler(INPUT, CTX_BUILD);
    expect(out.alreadyAssigned).toBe(true);
    expect(fake.mutations.insert).toBe(0);
    expect(fake.mutations.update).toBe(0);
    expect(mocks.emitAudit).not.toHaveBeenCalled();
  });

  it("resurrects a soft-deleted assignment instead of inserting (partial unique index)", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [SYSTEM_ROLE],
      [{ id: "pra-1", deletedAt: new Date("2026-01-01") }], // soft-deleted row
      [], // update
    );
    const out = await agentRoleAssignHandler(INPUT, CTX_BUILD);
    expect(out.alreadyAssigned).toBe(false);
    expect(fake.mutations.update).toBe(1);
    expect(fake.mutations.insert).toBe(0);
    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-agent system role (org Owner is never agent-assignable)", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [
        {
          id: "role-owner",
          publicId: "rol_owner",
          name: "Owner",
          scopeKind: "org",
          isSystemDefault: true,
        },
      ],
    );
    const err = await agentRoleAssignHandler(
      { agentId: "agt_1", roleName: "Owner" },
      CTX_BUILD,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRoleNotAssignableError);
    expect((err as AgentRoleNotAssignableError).code).toBe(
      "agent_role_not_assignable",
    );
    expect(fake.mutations.insert).toBe(0);
  });

  it("gates CUSTOM roles to enterprise (TierDeniedError on lower tiers)", async () => {
    fake.enqueue([AGENT_ROW], [CUSTOM_ROLE]);
    const err = await agentRoleAssignHandler(
      { agentId: "agt_1", roleName: "Data Steward" },
      CTX_BUILD,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TierDeniedError);
    expect((err as TierDeniedError).code).toBe("TIER_DENIED");
    expect(fake.mutations.insert).toBe(0);
  });

  it("rejects with agent_role_ceiling_exceeded when the role grants beyond the assigner's effective access", async () => {
    fake.enqueue(
      [AGENT_ROW], // agent select
      [CUSTOM_ROLE], // role select (custom, enterprise)
      [{ capabilityId: "create_agent_def", effect: "allow" }], // target role grants
      [{ id: "prn-user" }], // assigner principal
      [], // org roles (assigner holds none)
      [], // assigner PRA rows
      [], // assigner role grants
    );
    const err = await agentRoleAssignHandler(
      { agentId: "agt_1", roleName: "Data Steward" },
      CTX_ENTERPRISE,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRoleCeilingExceededError);
    expect((err as AgentRoleCeilingExceededError).code).toBe(
      "agent_role_ceiling_exceeded",
    );
    expect((err as AgentRoleCeilingExceededError).capabilities).toEqual([
      "create_agent_def",
    ]);
    expect(fake.mutations.insert).toBe(0);
    expect(mocks.emitAudit).not.toHaveBeenCalled();
  });

  it("assigns a custom role on enterprise when the assigner's own role grants cover it", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [CUSTOM_ROLE],
      [{ capabilityId: "create_agent_def", effect: "allow" }], // target role grants
      [{ id: "prn-user" }], // assigner principal
      [
        {
          id: "role-admin",
          name: "Admin",
          scopeKind: "org",
          orgId: "org_1",
          isSystemDefault: true,
        },
      ], // org roles
      [{ roleId: "role-admin" }], // assigner holds Admin
      [
        {
          roleId: "role-admin",
          capabilityId: "create_agent_def",
          effect: "allow",
        },
      ], // assigner role grants → resolver rule 7 allow
      [], // existing assignment select
      [], // insert
    );
    const out = await agentRoleAssignHandler(
      { agentId: "agt_1", roleName: "Data Steward" },
      CTX_ENTERPRISE,
    );
    expect(out.assigned).toBe(true);
    expect(fake.mutations.insert).toBe(1);
  });

  it("lets a system org Owner assign any role (resolver rule 7.5 super-user)", async () => {
    fake.enqueue(
      [AGENT_ROW],
      [CUSTOM_ROLE],
      [{ capabilityId: "create_agent_def", effect: "allow" }],
      [{ id: "prn-user" }],
      [
        {
          id: "role-owner",
          name: "Owner",
          scopeKind: "org",
          orgId: "org_1",
          isSystemDefault: true,
        },
      ],
      [{ roleId: "role-owner" }], // assigner is the system org Owner
      [], // no explicit role grants needed
      [], // existing assignment select
      [], // insert
    );
    const out = await agentRoleAssignHandler(
      { agentId: "agt_1", roleName: "Data Steward" },
      CTX_ENTERPRISE,
    );
    expect(out.assigned).toBe(true);
  });

  it("throws AgentRoleNotFoundError when the role name is unknown", async () => {
    fake.enqueue([AGENT_ROW], []); // role select empty
    const err = await agentRoleAssignHandler(INPUT, CTX_BUILD).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentRoleNotFoundError);
    expect((err as AgentRoleNotFoundError).code).toBe("agent_role_not_found");
  });

  it("throws AgentPrincipalMissingError for a pre-RBAC agent without a principal", async () => {
    fake.enqueue([{ ...AGENT_ROW, principalId: null }]);
    const err = await agentRoleAssignHandler(INPUT, CTX_BUILD).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentPrincipalMissingError);
    expect((err as AgentPrincipalMissingError).code).toBe(
      "agent_principal_missing",
    );
  });

  it("throws when the agent does not exist in this workspace", async () => {
    fake.enqueue([]); // agent select empty
    await expect(agentRoleAssignHandler(INPUT, CTX_BUILD)).rejects.toThrow(
      /Agent not found/,
    );
  });

  it("rejects an unauthenticated call", async () => {
    await expect(
      agentRoleAssignHandler(INPUT, makeCTX({ userId: null, apiKeyId: null })),
    ).rejects.toThrow(/Unauthorized/);
  });
});
