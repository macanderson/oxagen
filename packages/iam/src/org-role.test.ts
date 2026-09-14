// org-role.test.ts — unit tests for resolveActorOrgRole and assertOrgRole.
//
// Guards and their negatives:
//   - resolveActorOrgRole: no active principal → null; principal with no
//     org-scoped role → null; the assigned role name; expired (JIT)
//     assignments are excluded from the lookup
//   - assertOrgRole: no userId (an API-key call, or no actor) → forbidden
//     `no_principal` with no query; no principal, no role, or a role outside
//     the set → forbidden with `org_role_required`; a role in the set →
//     returns it

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  gt: vi.fn((col: unknown, val: unknown) => ({ __gt: [col, val] })),
  isNull: vi.fn((col: unknown) => ({ __isNull: col })),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

// Capture the expiry predicates without depending on Drizzle SQL internals.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return { ...real, gt: mocks.gt, isNull: mocks.isNull };
});

import { schema } from "@oxagen/database";
import { assertOrgRole, resolveActorOrgRole } from "./org-role";

/**
 * Tx double for the two-query role resolution: the principals lookup
 * (select→from→where→limit) then the role join (select→from→innerJoin→where→limit).
 */
function makeRoleTx(principalId: string | null, roleName: string | null) {
  let call = 0;
  return {
    select: () => {
      call++;
      const terminal = (rows: unknown[]) => ({
        where: () => ({ limit: () => Promise.resolve(rows) }),
      });
      if (call === 1) {
        return {
          from: () => terminal(principalId ? [{ id: principalId }] : []),
        };
      }
      return {
        from: () => ({
          innerJoin: () => terminal(roleName ? [{ roleName }] : []),
        }),
      };
    },
  };
}

function stubRoleResolution(
  principalId: string | null,
  roleName: string | null,
) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeRoleTx(principalId, roleName))),
  );
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
});
