import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  countVerified: vi.fn(),
  upsertRequired: vi.fn(),
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
  countVerifiedOrgSsoProviders: mocks.countVerified,
  upsertOrgSsoRequired: mocks.upsertRequired,
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

import { orgSsoPolicySetHandler } from "./org.sso.policy.set";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { SSO_BASE_URL } from "./test-utils/sso-fixtures";

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
  plan.resolveOrgTier.mockReset().mockResolvedValue("enterprise");
  process.env.BETTER_AUTH_URL = SSO_BASE_URL;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
  mocks.countVerified.mockResolvedValue(1);
});

describe("org.sso.policy.set handler", () => {
  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(
      orgSsoPolicySetHandler({ ssoRequired: true }, CTX),
    ).rejects.toThrow(/forbidden/);
    expect(mocks.upsertRequired).not.toHaveBeenCalled();
  });

  it("refuses to require SSO for an organisation that is not on the Enterprise plan", async () => {
    plan.resolveOrgTier.mockResolvedValue("scale");
    await expect(
      orgSsoPolicySetHandler({ ssoRequired: true }, CTX),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "sso_requires_enterprise",
    });
    expect(mocks.countVerified).not.toHaveBeenCalled();
    expect(mocks.upsertRequired).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("lets an organisation that left the Enterprise plan turn the requirement off", async () => {
    plan.resolveOrgTier.mockResolvedValue("free");
    await expect(
      orgSsoPolicySetHandler({ ssoRequired: false }, CTX),
    ).resolves.toEqual({ policy: { ssoRequired: false } });
    expect(plan.resolveOrgTier).not.toHaveBeenCalled();
    expect(mocks.upsertRequired).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      false,
      CTX.userId,
    );
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.policy_updated" }),
    );
  });

  it("requires SSO when a verified provider exists, and emits sso.policy_updated", async () => {
    await expect(
      orgSsoPolicySetHandler({ ssoRequired: true }, CTX),
    ).resolves.toEqual({ policy: { ssoRequired: true } });
    expect(mocks.countVerified).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
    );
    expect(mocks.upsertRequired).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      true,
      CTX.userId,
    );
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.policy_updated",
        capability: "set_sso_policy",
        detail: { ssoRequired: true },
      }),
    );
  });

  it("refuses to require SSO with no verified provider", async () => {
    mocks.countVerified.mockResolvedValue(0);
    await expect(
      orgSsoPolicySetHandler({ ssoRequired: true }, CTX),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "no_verified_provider",
    });
    expect(mocks.upsertRequired).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("turns the requirement off without checking for providers", async () => {
    mocks.countVerified.mockResolvedValue(0);
    await orgSsoPolicySetHandler({ ssoRequired: false }, CTX);
    expect(mocks.countVerified).not.toHaveBeenCalled();
    expect(mocks.upsertRequired).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      false,
      CTX.userId,
    );
    expect(mocks.emit.mock.calls[0]![0].detail).toEqual({ ssoRequired: false });
  });
});
