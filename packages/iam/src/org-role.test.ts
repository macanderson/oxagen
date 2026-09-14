// org-role.test.ts — unit tests for resolveActorOrgRole and assertOrgRole.
//
// Guards and their negatives:
//   - resolveActorOrgRole: no active principal → null; principal with no
//     org-scoped role → null; the assigned role name; expired (JIT)
//     assignments are excluded from the lookup
//   - resolveActorWorkspaceRole: the workspace-scoped assignment on the
//     named workspace, or null; the query is pinned to that workspace id
//   - assertOrgRole: no userId (an API-key call, or no actor) → forbidden
//     `no_principal` with no query; no principal, no role, or a role outside
//     the set → forbidden with `org_role_required`; a role in the set →
//     returns it; with a `workspace` requirement, a workspace role in that
//     set passes after the org leg fails, one outside it is refused, and a
//     context with no workspace never runs the workspace leg

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  gt: vi.fn((col: unknown, val: unknown) => ({ __gt: [col, val] })),
  isNull: vi.fn((col: unknown) => ({ __isNull: col })),
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: [col, val] })),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

// Capture the expiry and scope predicates without depending on Drizzle SQL
// internals.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, gt: mocks.gt, isNull: mocks.isNull, eq: mocks.eq };
});

import { schema } from "@oxagen/database";
import {
  assertOrgRole,
  resolveActorOrgRole,
  resolveActorWorkspaceRole,
} from "./org-role";

/**
 * Tx double for the role resolution: the principals lookup
 * (select→from→where→limit) then the role join
 * (select→from→innerJoin→where→limit). The join answers with the org-wide
 * role unless the WHERE pinned a workspace id, in which case it answers with
 * the workspace role — the same shape the two scoped queries take in Postgres.
 */
function makeRoleTx(
  principalId: string | null,
  roleName: string | null,
  workspaceRoleName: string | null = null,
) {
  const pinsWorkspace = () =>
    mocks.eq.mock.calls.some(
      ([col, val]) =>
        col === schema.principalRoleAssignments.workspaceId &&
        typeof val === "string",
    );
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.principals) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve(principalId ? [{ id: principalId }] : []),
            }),
          };
        }
        return {
          innerJoin: () => ({
            where: () => ({
              limit: () => {
                const name = pinsWorkspace() ? workspaceRoleName : roleName;
                return Promise.resolve(name ? [{ roleName: name }] : []);
              },
            }),
          }),
        };
      },
    }),
  };
}

function stubRoleResolution(
  principalId: string | null,
  roleName: string | null,
  workspaceRoleName: string | null = null,
) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeRoleTx(principalId, roleName, workspaceRoleName))),
  );
}

/** The workspace ids the role join was pinned to, in call order. */
function pinnedWorkspaceIds(): unknown[] {
  return mocks.eq.mock.calls
    .filter(([col]) => col === schema.principalRoleAssignments.workspaceId)
    .map(([, val]) => val);
}

const forbidden = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === reason;

describe("resolveActorOrgRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the user has no active principal in the org", async () => {
    stubRoleResolution(null, null);
    expect(await resolveActorOrgRole("org_1", "user_1")).toBeNull();
  });

  it("returns null when the principal holds no org-scoped role", async () => {
    stubRoleResolution("prn_1", null);
    expect(await resolveActorOrgRole("org_1", "user_1")).toBeNull();
  });

  it("returns the assigned org role name", async () => {
    stubRoleResolution("prn_1", "Admin");
    expect(await resolveActorOrgRole("org_1", "user_1")).toBe("Admin");
  });

  it("excludes expired (JIT) role assignments from the role lookup", async () => {
    // A time-bounded Admin grant that has lapsed must stop granting Admin, the
    // same way the kernel resolver's isExpired() treats an expired grant.
    stubRoleResolution("prn_1", "Admin");
    await resolveActorOrgRole("org_1", "user_1");

    expect(mocks.isNull).toHaveBeenCalledWith(
      schema.principalRoleAssignments.expiresAt,
    );
    const gtCall = mocks.gt.mock.calls.find(
      ([col]) => col === schema.principalRoleAssignments.expiresAt,
    );
    expect(gtCall).toBeDefined();
    expect(gtCall?.[1]).toBeInstanceOf(Date);
  });
});

describe("assertOrgRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const OWNER_ADMIN = { org: ["Owner", "Admin"] } as const;
  const USER = { orgId: "org_1", userId: "user_1" } as const;

  it("refuses a context with no user before any query", async () => {
    stubRoleResolution("prn_1", "Owner");
    await expect(
      assertOrgRole({ orgId: "org_1", userId: null }, OWNER_ADMIN),
    ).rejects.toSatisfy(forbidden("no_principal"));
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses an API-key call the same way: a key holds no org role here", async () => {
    stubRoleResolution("prn_1", "Owner");
    const ctx = { orgId: "org_1", userId: null, apiKeyId: "aky_1" };
    await expect(assertOrgRole(ctx, OWNER_ADMIN)).rejects.toSatisfy(
      forbidden("no_principal"),
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("refuses an actor with no active principal in the org", async () => {
    stubRoleResolution(null, null);
    await expect(assertOrgRole(USER, OWNER_ADMIN)).rejects.toSatisfy(
      forbidden("org_role_required"),
    );
  });

  it("refuses a principal that holds no org-scoped role", async () => {
    stubRoleResolution("prn_1", null);
    await expect(assertOrgRole(USER, OWNER_ADMIN)).rejects.toSatisfy(
      forbidden("org_role_required"),
    );
  });

  it.each(["Member", "Viewer", "Billing", "Compliance"])(
    "refuses the org role %s when the set is Owner and Admin",
    async (role) => {
      stubRoleResolution("prn_1", role);
      await expect(assertOrgRole(USER, OWNER_ADMIN)).rejects.toSatisfy(
        forbidden("org_role_required"),
      );
    },
  );

  it.each(["Owner", "Admin"])(
    "returns the role %s when it is in the set",
    async (role) => {
      stubRoleResolution("prn_1", role);
      await expect(assertOrgRole(USER, OWNER_ADMIN)).resolves.toBe(role);
    },
  );

  it("accepts a role outside Owner/Admin when the handler names it", async () => {
    stubRoleResolution("prn_1", "Billing");
    await expect(
      assertOrgRole(USER, { org: ["Owner", "Billing"] }),
    ).resolves.toBe("Billing");
  });

  it("never runs the workspace leg for an org-only requirement", async () => {
    stubRoleResolution("prn_1", "Viewer", "Owner");
    await expect(
      assertOrgRole({ ...USER, workspaceId: "ws_1" }, OWNER_ADMIN),
    ).rejects.toSatisfy(forbidden("org_role_required"));
    expect(pinnedWorkspaceIds()).toEqual([]);
  });
});

describe("resolveActorWorkspaceRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the user has no active principal in the org", async () => {
    stubRoleResolution(null, null, "Owner");
    expect(
      await resolveActorWorkspaceRole("org_1", "ws_1", "user_1"),
    ).toBeNull();
  });

  it("returns null when the principal holds no role on that workspace", async () => {
    stubRoleResolution("prn_1", "Admin", null);
    expect(
      await resolveActorWorkspaceRole("org_1", "ws_1", "user_1"),
    ).toBeNull();
  });

  it("returns the workspace role, with the join pinned to the named workspace", async () => {
    stubRoleResolution("prn_1", null, "Member");
    expect(await resolveActorWorkspaceRole("org_1", "ws_1", "user_1")).toBe(
      "Member",
    );
    expect(pinnedWorkspaceIds()).toEqual(["ws_1"]);
    expect(mocks.eq).toHaveBeenCalledWith(schema.roles.scopeKind, "workspace");
  });
});

describe("assertOrgRole with a workspace requirement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const APPROVER = {
    org: ["Owner", "Admin"],
    workspace: ["Owner", "Member"],
  } as const;
  const IN_WS = {
    orgId: "org_1",
    workspaceId: "ws_1",
    userId: "user_1",
  } as const;

  it.each(["Owner", "Admin"])(
    "returns the org role %s without reading the workspace",
    async (role) => {
      stubRoleResolution("prn_1", role, null);
      await expect(assertOrgRole(IN_WS, APPROVER)).resolves.toBe(role);
      expect(pinnedWorkspaceIds()).toEqual([]);
    },
  );

  it.each(["Owner", "Member"])(
    "returns the workspace role %s when the org leg fails",
    async (role) => {
      stubRoleResolution("prn_1", "Viewer", role);
      await expect(assertOrgRole(IN_WS, APPROVER)).resolves.toBe(role);
      expect(pinnedWorkspaceIds()).toEqual(["ws_1"]);
    },
  );

  it("refuses a workspace Viewer whose org role is also outside the set", async () => {
    stubRoleResolution("prn_1", "Viewer", "Viewer");
    await expect(assertOrgRole(IN_WS, APPROVER)).rejects.toSatisfy(
      forbidden("org_role_required"),
    );
  });

  it("refuses a user with no role on the workspace and none in the org", async () => {
    stubRoleResolution("prn_1", null, null);
    await expect(assertOrgRole(IN_WS, APPROVER)).rejects.toSatisfy(
      forbidden("org_role_required"),
    );
  });

  it("refuses a workspace role from a context that names no workspace", async () => {
    // An org-only context cannot borrow a workspace assignment: without a
    // workspace id there is nothing to pin the join to, so the leg is skipped.
    stubRoleResolution("prn_1", "Viewer", "Owner");
    await expect(
      assertOrgRole({ orgId: "org_1", userId: "user_1" }, APPROVER),
    ).rejects.toSatisfy(forbidden("org_role_required"));
    expect(pinnedWorkspaceIds()).toEqual([]);
  });

  it("refuses a context with no user before any query", async () => {
    stubRoleResolution("prn_1", "Owner", "Owner");
    await expect(
      assertOrgRole({ ...IN_WS, userId: null }, APPROVER),
    ).rejects.toSatisfy(forbidden("no_principal"));
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
