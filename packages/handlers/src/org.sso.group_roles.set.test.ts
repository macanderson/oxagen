import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  find: vi.fn(),
  replace: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emit,
}));
vi.mock("./lib/sso-store", () => ({
  findOrgSsoProvider: mocks.find,
  replaceOrgSsoGroupRoles: mocks.replace,
}));

// The plan behind the Enterprise check (ADR-144). Enterprise by default, so
// each case tests its own behaviour; the refusal case sets another tier.
const plan = vi.hoisted(() => ({ resolveOrgTier: vi.fn() }));
vi.mock("@oxagen/billing", () => ({
  canAccessSSO: (tier: string) => tier === "enterprise",
  resolveOrgTier: plan.resolveOrgTier,
}));

// The org-role gate every SSO handler asserts (INV-29). Allows by default, an
// org Admin, so each case tests its own behaviour; the refusal case sets
// `roleGate.refuse` and asserts nothing else ran.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Admin";
  }),
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { orgSsoGroupRolesSetHandler } from "./org.sso.group_roles.set";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { SSO_BASE_URL, ssoRow } from "./test-utils/sso-fixtures";

const MAPPINGS = [
  { group: "platform-admins", role: "admin" as const },
  { group: "finance", role: "billing" as const },
];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
  plan.resolveOrgTier.mockReset().mockResolvedValue("enterprise");
  process.env.BETTER_AUTH_URL = SSO_BASE_URL;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
  mocks.find.mockResolvedValue(ssoRow());
});

describe("org.sso.group_roles.set handler", () => {
  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(
      orgSsoGroupRolesSetHandler(
        { providerId: "acme", mappings: MAPPINGS },
        CTX,
      ),
    ).rejects.toThrow(/forbidden/);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("refuses an organisation that is not on the Enterprise plan", async () => {
    plan.resolveOrgTier.mockResolvedValue("scale");
    await expect(
      orgSsoGroupRolesSetHandler(
        { providerId: "acme", mappings: MAPPINGS },
        CTX,
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "sso_requires_enterprise",
    });
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("replaces the table for a provider of the caller's organisation, in one transaction", async () => {
    const out = await orgSsoGroupRolesSetHandler(
      { providerId: "acme", mappings: MAPPINGS },
      CTX,
    );
    expect(out).toEqual({ providerId: "acme", mappings: MAPPINGS });
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.find).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      "acme",
    );
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      "acme",
      MAPPINGS,
      CTX.userId,
    );
  });

  it("emits sso.group_roles_set with the table after the write", async () => {
    await orgSsoGroupRolesSetHandler(
      { providerId: "acme", mappings: MAPPINGS },
      CTX,
    );
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.group_roles_set",
        capability: "set_sso_group_roles",
        detail: { providerId: "acme", mappings: MAPPINGS },
      }),
    );
  });

  it("reads a provider of another organisation as not found and writes nothing", async () => {
    mocks.find.mockResolvedValue(null);
    await expect(
      orgSsoGroupRolesSetHandler(
        { providerId: "acme", mappings: MAPPINGS },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("accepts an empty table, which clears it", async () => {
    await orgSsoGroupRolesSetHandler({ providerId: "acme", mappings: [] }, CTX);
    expect(mocks.replace).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      "acme",
      [],
      CTX.userId,
    );
  });
});
