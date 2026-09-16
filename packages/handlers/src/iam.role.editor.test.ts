// create_role, set_role_grants and delete_role over a fake role store
// (ADR-063). The role gate reads the fake database by table, as in the other
// INV-29 handler tests; the store, the ceiling reads and the tier are fakes
// the tests set per case. Every guard has its negative.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { tenant, emitted } = vi.hoisted(() => ({
  /** The actor's org principal and role, as assertOrgRole reads them. */
  tenant: {
    principalId: "prn_1" as string | null,
    roleName: "Owner" as string | null,
    /** The creator an API key resolves to, or none (a deleted or unknown key). */
    keyCreator: "00000000-0000-0000-0000-00000000000c" as string | null,
  },
  emitted: [] as Array<{ eventType: string; capability: string | null }>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const rowsFor = (table: unknown): unknown[] => {
    if (table === real.schema.apiKeys)
      return tenant.keyCreator ? [{ createdByUserId: tenant.keyCreator }] : [];
    if (table === real.schema.principals)
      return tenant.principalId ? [{ id: tenant.principalId }] : [];
    if (table === real.schema.principalRoleAssignments)
      return tenant.roleName ? [{ roleName: tenant.roleName }] : [];
    throw new Error("unexpected table");
  };
  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => Promise.resolve(rowsFor(table)),
        };
        return chain;
      },
    }),
  };
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: vi.fn(
    async (e: { eventType: string; capability: string | null }) => {
      emitted.push({ eventType: e.eventType, capability: e.capability });
    },
  ),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { capabilitiesOf } from "@oxagen/oxagen/iam";
import type { DelegationCeilingReads } from "@oxagen/iam";
import { createRoleHandler } from "./iam.role.create";
import { createDeleteRoleHandler } from "./iam.role.delete";
import { createSetRoleGrantsHandler } from "./iam.role.grants.set";
import type { RoleGrantRecord, RoleRecord, RoleStore } from "./lib/iam-roles";

const ORG = "00000000-0000-0000-0000-00000000000a";
const WS = "00000000-0000-0000-0000-00000000000b";
const USER = "00000000-0000-0000-0000-00000000000c";

const ctx: CapabilityContext = {
  orgId: ORG,
  workspaceId: WS,
  userId: USER,
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

/** An MCP call: an API key, no signed-in user. The key's creator is USER. */
const keyCtx: CapabilityContext = {
  ...ctx,
  userId: null,
  apiKeyId: "00000000-0000-0000-0000-00000000000d",
  surface: "mcp",
};

/** An in-memory role store: roles, grants, assignment counts, and the granter's own allow set. */
function fakeStore() {
  const roles = new Map<string, RoleRecord>();
  const grants = new Map<string, RoleGrantRecord[]>();
  const holders = new Map<string, number>();
  /** What the granter holds, as the ceiling reads it: one org role with allow grants. */
  const granter = { allowed: new Set<string>(), systemOwner: false };
  let seq = 0;
  const ceiling: DelegationCeilingReads = {
    assignerPrincipalId: async () => "prn-granter",
    orgRoles: async () => [
      {
        id: "role-granter",
        name: granter.systemOwner ? "Owner" : "Granter",
        scopeKind: "org",
        orgId: ORG,
        isSystemDefault: granter.systemOwner,
      },
    ],
    assignerRoleIds: async () => ["role-granter"],
    roleGrantsOn: async (_roleIds, capabilityIds) =>
      capabilityIds
        .filter((c) => granter.allowed.has(c))
        .map((capabilityId) => ({
          roleId: "role-granter",
          capabilityId,
          effect: "allow" as const,
        })),
  };
  const store: RoleStore = {
    ceiling,
    async roleByPublicId(orgId, publicId) {
      const role = [...roles.values()].find(
        (r) => r.publicId === publicId && orgId === ORG,
      );
      return role ?? null;
    },
    async insertRole(row) {
      // roles_org_scope_name_uq, and roles_org_custom_name_uq for custom roles.
      const taken = [...roles.values()].some(
        (r) =>
          r.name.toLowerCase() === row.name.toLowerCase() &&
          (r.scopeKind === row.scopeKind || !r.isSystemDefault),
      );
      if (taken) {
        throw Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint_name: "roles_org_scope_name_uq",
        });
      }
      seq += 1;
      const role: RoleRecord = {
        id: `uuid-${seq}`,
        publicId: `rol_${seq}`,
        name: row.name,
        scopeKind: row.scopeKind,
        description: row.description,
        isSystemDefault: false,
        version: "1",
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
        createdByUserId: row.createdByUserId,
      };
      roles.set(role.id, role);
      return role;
    },
    async replaceGrants(_orgId, roleId, capabilityIds) {
      grants.set(
        roleId,
        capabilityIds.map((capability) => ({ capability, effect: "allow" })),
      );
    },
    async activeAssignmentCount(_orgId, roleId) {
      return holders.get(roleId) ?? 0;
    },
    async deleteRole(_orgId, roleId) {
      roles.delete(roleId);
      grants.delete(roleId);
    },
    async userName() {
      return "Priya Natarajan";
    },
  };
  const seed = (role: Partial<RoleRecord> & { id: string; name: string }) => {
    roles.set(role.id, {
      publicId: `rol_${role.id}`,
      scopeKind: "workspace",
      description: null,
      isSystemDefault: false,
      version: "1",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      createdByUserId: USER,
      ...role,
    });
  };
  return { store, roles, grants, holders, granter, seed };
}

let fake: ReturnType<typeof fakeStore>;

const deps = () => ({
  withStore: <T>(fn: (store: RoleStore) => Promise<T>) => fn(fake.store),
});

const refusal = async (p: Promise<unknown>) => {
  const err = await p.catch((e) => e);
  if (!isHandlerError(err))
    throw new Error(`expected a HandlerError, got ${err}`);
  return { code: err.code, reason: err.reason };
};

const createInput = (
  over: Partial<Parameters<typeof iamRoleCreate.input.parse>[0]> = {},
) =>
  iamRoleCreate.input.parse({
    name: "agent.release",
    scopeKind: "workspace",
    permissions: ["run.read", "run.control"],
    ...over,
  });

beforeEach(() => {
  tenant.principalId = "prn_1";
  tenant.roleName = "Owner";
  tenant.keyCreator = USER;
  emitted.length = 0;
  fake = fakeStore();
  for (const c of capabilitiesOf(["run.read", "run.control", "repo.read"]))
    fake.granter.allowed.add(c);
});

describe("create_role", () => {
  const handler = () => createRoleHandler(deps());

  it("writes the role and one allow grant per capability the permissions name, and reports the row", async () => {
    const out = await handler()(createInput(), ctx);
    expect(out.role.name).toBe("agent.release");
    expect(out.role.kind).toBe("agent");
    expect(out.role.isSystemDefault).toBe(false);
    expect(out.role.permissions).toEqual(["run.read", "run.control"]);
    expect(out.role.memberCount).toBe(0);
    expect(out.role.createdBy).toBe("Priya Natarajan");
    expect(iamRoleCreate.output.safeParse(out).success).toBe(true);
    const stored = fake.grants
      .get("uuid-1")
      ?.map((g) => g.capability)
      .sort();
    expect(stored).toEqual(capabilitiesOf(["run.read", "run.control"]));
    expect(fake.grants.get("uuid-1")?.every((g) => g.effect === "allow")).toBe(
      true,
    );
    expect(emitted).toEqual([
      { eventType: "iam.role_created", capability: "create_role" },
    ]);
  });

  it.each(["Member", "Billing", "Compliance", "Viewer"])(
    "refuses an org %s with forbidden / org_role_required before any write (negative)",
    async (roleName) => {
      tenant.roleName = roleName;
      await expect(refusal(handler()(createInput(), ctx))).resolves.toEqual({
        code: "forbidden",
        reason: "org_role_required",
      });
      expect(fake.roles.size).toBe(0);
    },
  );

  it("refuses a context with no user (negative)", async () => {
    await expect(
      refusal(handler()(createInput(), { ...ctx, userId: null })),
    ).resolves.toEqual({ code: "forbidden", reason: "no_principal" });
  });

  it("refuses a grant above the granter's ceiling, naming the capabilities, and writes nothing (negative)", async () => {
    const err = await handler()(
      createInput({ permissions: ["run.read", "run.approve"] }),
      ctx,
    ).catch((e) => e);
    expect(isHandlerError(err) && err.code).toBe("forbidden");
    expect(isHandlerError(err) && err.reason).toBe(
      "delegation_ceiling_exceeded",
    );
    expect(String(err.message)).toContain("resolve_approval");
    expect(fake.roles.size).toBe(0);
  });

  it("lets the system org Owner create a role over any permission", async () => {
    fake.granter.allowed.clear();
    fake.granter.systemOwner = true;
    const out = await handler()(
      createInput({ permissions: ["run.approve", "budget.set"] }),
      ctx,
    );
    expect(out.role.permissions).toEqual(["run.approve", "budget.set"]);
  });

  it("reads the unique index's violation as conflict / role_exists (negative)", async () => {
    await handler()(createInput(), ctx);
    await expect(refusal(handler()(createInput(), ctx))).resolves.toEqual({
      code: "conflict",
      reason: "role_exists",
    });
  });

  it("refuses a custom role whose name another custom role holds in the other scope kind, so a name lookup finds one row (negative)", async () => {
    await handler()(createInput({ scopeKind: "workspace" }), ctx);
    await expect(
      refusal(handler()(createInput({ scopeKind: "org" }), ctx)),
    ).resolves.toEqual({ code: "conflict", reason: "role_exists" });
    expect([...fake.roles.values()].map((r) => r.scopeKind)).toEqual([
      "workspace",
    ]);
  });

  it("lets a custom role share a seeded role's name in the other scope kind only through case, which the name lookup tells apart", async () => {
    fake.seed({
      id: "owner",
      name: "Owner",
      scopeKind: "org",
      isSystemDefault: true,
    });
    await expect(
      refusal(handler()(createInput({ name: "owner", scopeKind: "org" }), ctx)),
    ).resolves.toEqual({ code: "conflict", reason: "role_exists" });
    const out = await handler()(
      createInput({ name: "owner", scopeKind: "workspace" }),
      ctx,
    );
    expect(out.role.name).toBe("owner");
  });

  it("acts as the API key's creator on an MCP call: an Owner creator creates the role as that user", async () => {
    const out = await handler()(createInput(), keyCtx);
    expect(out.role.createdBy).toBe("Priya Natarajan");
    expect([...fake.roles.values()][0]?.createdByUserId).toBe(USER);
  });

  it("refuses an MCP call whose key creator is an org Member (negative)", async () => {
    tenant.roleName = "Member";
    await expect(refusal(handler()(createInput(), keyCtx))).resolves.toEqual({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(fake.roles.size).toBe(0);
  });

  it("refuses an MCP call whose key resolves to no creator (negative)", async () => {
    tenant.keyCreator = null;
    await expect(refusal(handler()(createInput(), keyCtx))).resolves.toEqual({
      code: "forbidden",
      reason: "no_principal",
    });
  });
});

describe("set_role_grants", () => {
  const handler = () => createSetRoleGrantsHandler(deps());
  const input = (permissions: string[], roleId = "rol_custom") =>
    iamRoleGrantsSet.input.parse({ roleId, permissions });

  beforeEach(() => {
    fake.seed({ id: "custom", name: "agent.release" });
    fake.grants.set("custom", [
      { capability: "list_runs", effect: "allow" },
      { capability: "search_graph", effect: "allow" },
    ]);
    fake.seed({
      id: "system",
      name: "Agent Operator",
      isSystemDefault: true,
    });
  });

  it("replaces every grant with the new permission set and reports the holders", async () => {
    fake.holders.set("custom", 3);
    const out = await handler()(input(["run.control"]), ctx);
    expect(out.role.permissions).toEqual(["run.control"]);
    expect(out.role.memberCount).toBe(3);
    expect(fake.grants.get("custom")).toEqual([
      { capability: "dispatch_command", effect: "allow" },
    ]);
    expect(emitted).toEqual([
      { eventType: "iam.role_grants_set", capability: "set_role_grants" },
    ]);
  });

  it("refuses a system role with conflict / system_role_readonly and changes nothing (negative)", async () => {
    await expect(
      refusal(handler()(input(["run.read"], "rol_system"), ctx)),
    ).resolves.toEqual({ code: "conflict", reason: "system_role_readonly" });
    expect(fake.grants.get("system")).toBeUndefined();
  });

  it("refuses a role outside the org with not_found (negative)", async () => {
    await expect(
      refusal(handler()(input(["run.read"], "rol_elsewhere"), ctx)),
    ).resolves.toEqual({ code: "not_found", reason: "role_not_found" });
  });

  it("refuses a set above the granter's ceiling and keeps the old grants (negative)", async () => {
    await expect(
      refusal(handler()(input(["run.read", "budget.set"]), ctx)),
    ).resolves.toEqual({
      code: "forbidden",
      reason: "delegation_ceiling_exceeded",
    });
    expect(fake.grants.get("custom")?.map((g) => g.capability)).toEqual([
      "list_runs",
      "search_graph",
    ]);
  });

  it("acts as the API key's creator on an MCP call, and refuses a Member creator (negative)", async () => {
    const out = await handler()(input(["run.control"]), keyCtx);
    expect(out.role.permissions).toEqual(["run.control"]);
    tenant.roleName = "Member";
    await expect(
      refusal(handler()(input(["run.read"]), keyCtx)),
    ).resolves.toEqual({ code: "forbidden", reason: "org_role_required" });
    expect(fake.grants.get("custom")).toEqual([
      { capability: "dispatch_command", effect: "allow" },
    ]);
  });

  it("refuses an org Member (negative)", async () => {
    tenant.roleName = "Member";
    await expect(refusal(handler()(input(["run.read"]), ctx))).resolves.toEqual(
      { code: "forbidden", reason: "org_role_required" },
    );
  });
});

describe("delete_role", () => {
  const handler = () => createDeleteRoleHandler(deps());
  const input = (roleId: string) => iamRoleDelete.input.parse({ roleId });

  beforeEach(() => {
    fake.seed({ id: "custom", name: "agent.release" });
    fake.grants.set("custom", [{ capability: "list_runs", effect: "allow" }]);
    fake.seed({
      id: "system",
      name: "Owner",
      scopeKind: "org",
      isSystemDefault: true,
    });
  });

  it("deletes a custom role nobody holds, with its grants", async () => {
    const out = await handler()(input("rol_custom"), ctx);
    expect(out).toEqual({ id: "rol_custom", name: "agent.release" });
    expect(fake.roles.has("custom")).toBe(false);
    expect(fake.grants.has("custom")).toBe(false);
    expect(emitted).toEqual([
      { eventType: "iam.role_deleted", capability: "delete_role" },
    ]);
  });

  it("refuses a role a principal still holds with conflict / role_in_use (negative)", async () => {
    fake.holders.set("custom", 2);
    const err = await handler()(input("rol_custom"), ctx).catch((e) => e);
    expect(isHandlerError(err) && err.reason).toBe("role_in_use");
    expect(String(err.message)).toContain("2 principals");
    expect(fake.roles.has("custom")).toBe(true);
  });

  it("refuses a system role and a role outside the org (negative)", async () => {
    await expect(refusal(handler()(input("rol_system"), ctx))).resolves.toEqual(
      { code: "conflict", reason: "system_role_readonly" },
    );
    await expect(refusal(handler()(input("rol_nope"), ctx))).resolves.toEqual({
      code: "not_found",
      reason: "role_not_found",
    });
    expect(fake.roles.has("system")).toBe(true);
  });

  it("refuses an MCP call whose key creator is an org Member, and deletes as an Owner creator", async () => {
    tenant.roleName = "Member";
    await expect(
      refusal(handler()(input("rol_custom"), keyCtx)),
    ).resolves.toEqual({ code: "forbidden", reason: "org_role_required" });
    expect(fake.roles.has("custom")).toBe(true);
    tenant.roleName = "Owner";
    await expect(handler()(input("rol_custom"), keyCtx)).resolves.toEqual({
      id: "rol_custom",
      name: "agent.release",
    });
    expect(fake.roles.has("custom")).toBe(false);
  });

  it("refuses an org Viewer before reading the role (negative)", async () => {
    tenant.roleName = "Viewer";
    await expect(refusal(handler()(input("rol_custom"), ctx))).resolves.toEqual(
      { code: "forbidden", reason: "org_role_required" },
    );
    expect(fake.roles.has("custom")).toBe(true);
  });
});
