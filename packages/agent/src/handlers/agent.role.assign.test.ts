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

// The audit sink is stubbed; the delegation ceiling runs for real over the
// fake transaction below (its reads are the same select chains).
vi.mock("@oxagen/iam", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/iam")>()),
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

import { agentRoleAssignHandler } from "./agent.role.assign";
import {
  AgentPrincipalMissingError,
  AgentRoleCeilingExceededError,
  AgentRoleNotAssignableError,
  AgentRoleNotFoundError,
} from "./_agent-role";
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
  vi.mocked(withTransactionOrgScope).mockClear();
  mocks.emitAudit.mockClear();
  gate.keyCreator = "u_creator";
  gate.orgRole = "Owner";
  gate.calls = [];
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
    expect(withTransactionOrgScope).toHaveBeenCalledWith(
      fake.tx,
      expect.any(Function),
    );
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

  // ADR-069 removed the tier gate from create_role and set_role_grants but
  // left this one, so on Free, Build and Scale the Roles editor created custom
  // roles that nothing could bind — a working editor and an invisible wall at
  // the last step. The tier decides whether the kernel RESOLVES a grant, which
  // list_iam_roles reports as `enforcement`; it never decided whether a role
  // may be held.
  it("assigns a CUSTOM role at a non-enterprise tier, with no ceiling queries", async () => {
    fake.enqueue(
      [AGENT_ROW], // agent select
      [CUSTOM_ROLE], // role select (custom)
      [], // existing assignment select
      [], // pra insert
    );
    const out = await agentRoleAssignHandler(
      { agentId: "agt_1", roleName: "Data Steward" },
      CTX_BUILD,
    );
    expect(out.assigned).toBe(true);
    expect(fake.mutations.insert).toBe(1);
  });

  // The ceiling is still the control, and it still runs where the resolver does.
  it("still refuses a human org role at a non-enterprise tier (negative)", async () => {
    fake.enqueue([AGENT_ROW], [{ ...SYSTEM_ROLE, name: "Owner" }]);
    const err = await agentRoleAssignHandler(
      { agentId: "agt_1", roleName: "Owner" },
      CTX_BUILD,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRoleNotAssignableError);
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

  it("refuses a retired (archived) agent before any role read or write", async () => {
    fake.enqueue([{ ...AGENT_ROW, status: "archived" }], [SYSTEM_ROLE], []);
    await expect(
      agentRoleAssignHandler(INPUT, CTX_BUILD),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "agent_retired",
      message: 'Agent "my-agent" is retired',
    });
    expect(fake.mutations).toEqual({ insert: 0, update: 0, delete: 0 });
    expect(mocks.emitAudit).not.toHaveBeenCalled();
  });

  it("throws when the agent does not exist in this workspace", async () => {
    fake.enqueue([]); // agent select empty
    await expect(agentRoleAssignHandler(INPUT, CTX_BUILD)).rejects.toThrow(
      /Agent not found/,
    );
  });
});

describe("agent.role.assign — role gate (org Owner or Admin)", () => {
  const forbidden = (reason: string) => ({ code: "forbidden", reason });

  it("gates the signed-in user on org Owner or Admin", async () => {
    fake.enqueue([AGENT_ROW], [SYSTEM_ROLE], [], []);
    await agentRoleAssignHandler(INPUT, CTX_BUILD);
    expect(gate.calls).toEqual([{ userId: "u_1", org: ["Owner", "Admin"] }]);
  });

  it("refuses an org Member before any query, and writes and audits nothing (negative)", async () => {
    gate.orgRole = "Member";
    await expect(
      agentRoleAssignHandler(INPUT, CTX_BUILD),
    ).rejects.toMatchObject(forbidden("org_role_required"));
    expect(fake.mutations.insert).toBe(0);
    expect(fake.mutations.update).toBe(0);
    expect(mocks.emitAudit).not.toHaveBeenCalled();
  });

  it("refuses a call with no user and no API key with no_principal (negative)", async () => {
    await expect(
      agentRoleAssignHandler(INPUT, makeCTX({ userId: null, apiKeyId: null })),
    ).rejects.toMatchObject(forbidden("no_principal"));
    expect(fake.mutations.insert).toBe(0);
  });

  describe("an API-key call acts as the key's creator", () => {
    const KEY_CTX = makeCTX({
      planTier: "build",
      userId: null,
      apiKeyId: "aky_1",
    });

    it("assigns for a creator who is an org Admin", async () => {
      gate.orgRole = "Admin";
      fake.enqueue([AGENT_ROW], [SYSTEM_ROLE], [], []);
      const out = await agentRoleAssignHandler(INPUT, KEY_CTX);
      expect(out.assigned).toBe(true);
      expect(gate.calls).toEqual([
        { userId: "u_creator", org: ["Owner", "Admin"] },
      ]);
      expect(fake.mutations.insert).toBe(1);
    });

    it("refuses a key whose creator is an org Member (negative)", async () => {
      gate.orgRole = "Member";
      await expect(
        agentRoleAssignHandler(INPUT, KEY_CTX),
      ).rejects.toMatchObject(forbidden("org_role_required"));
      expect(fake.mutations.insert).toBe(0);
    });

    it("refuses a key with no creator (negative)", async () => {
      gate.keyCreator = null;
      await expect(
        agentRoleAssignHandler(INPUT, KEY_CTX),
      ).rejects.toMatchObject(forbidden("no_principal"));
      expect(fake.mutations.insert).toBe(0);
    });
  });
});

// ── Q1 regression: no back-compat "Agent Legacy" role ─────────────────────────

describe("AGENT_SYSTEM_ROLE_NAMES — tier-exemption allow-list", () => {
  it("contains exactly the three seeded system roles", async () => {
    const { AGENT_SYSTEM_ROLE_NAMES } = await import("./_agent-role");
    expect([...AGENT_SYSTEM_ROLE_NAMES].sort()).toEqual([
      "Agent Contributor",
      "Agent Observer",
      "Agent Operator",
    ]);
  });

  it("excludes the spec's back-compat 'Agent Legacy (unrestricted)' role", async () => {
    // Spec §6 Q1: pre-launch, no customers, so no back-compat role is seeded.
    // Membership in this set is a TIER EXEMPTION — listing an unseeded name
    // would let an org mint a CUSTOM role under it and have it treated as a
    // tier-exempt system role, escalating under a name meaning "unrestricted".
    const { AGENT_SYSTEM_ROLE_NAMES } = await import("./_agent-role");
    expect(AGENT_SYSTEM_ROLE_NAMES.has("Agent Legacy (unrestricted)")).toBe(
      false,
    );
  });
});
