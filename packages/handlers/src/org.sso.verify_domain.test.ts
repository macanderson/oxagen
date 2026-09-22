import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  listRoles: vi.fn(),
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
  updateOrgSsoProvider: mocks.update,
  listOrgSsoGroupRoles: mocks.listRoles,
}));

// The plan behind the Enterprise check (ADR-142). Enterprise by default, so
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

import { orgSsoVerifyDomainHandler } from "./org.sso.verify_domain";
import { setSsoResolveTxtForTests } from "./lib/sso";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { SSO_BASE_URL, ssoRow } from "./test-utils/sso-fixtures";

const resolveTxt = vi.fn();
const RECORD = "_oxagen-sso.acme.com";
const VALUE = "oxagen-sso-verification=tok123";

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
  mocks.update.mockImplementation(async (_tx, _org, _pid, p) => ({
    ...ssoRow(),
    ...p,
  }));
  mocks.listRoles.mockResolvedValue([]);
  resolveTxt.mockReset();
  setSsoResolveTxtForTests(resolveTxt);
});

afterEach(() => {
  setSsoResolveTxtForTests(null);
});

describe("org.sso.verify_domain handler", () => {
  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(
      orgSsoVerifyDomainHandler({ providerId: "acme" }, CTX),
    ).rejects.toThrow(/forbidden/);
    expect(resolveTxt).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses an organisation that is not on the Enterprise plan", async () => {
    plan.resolveOrgTier.mockResolvedValue("free");
    await expect(
      orgSsoVerifyDomainHandler({ providerId: "acme" }, CTX),
    ).rejects.toMatchObject({
      code: "forbidden",
      reason: "sso_requires_enterprise",
    });
    expect(resolveTxt).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("marks the domain verified when a TXT value matches, joining chunked records", async () => {
    resolveTxt.mockResolvedValue([
      ["v=spf1 -all"],
      ["oxagen-sso-verification=", "tok123"],
    ]);
    const out = await orgSsoVerifyDomainHandler({ providerId: "acme" }, CTX);
    expect(resolveTxt).toHaveBeenCalledWith(RECORD);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      "acme",
      { domainVerified: true },
    );
    expect(out.provider.domainVerified).toBe(true);
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.domain_verified",
        capability: "verify_sso_domain",
        detail: { providerId: "acme", protocol: "oidc", domain: "acme.com" },
      }),
    );
  });

  it("is a conflict naming the record to publish when no value matches", async () => {
    resolveTxt.mockResolvedValue([["oxagen-sso-verification=someone-else"]]);
    const err = await orgSsoVerifyDomainHandler(
      { providerId: "acme" },
      CTX,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "dns_record_not_found",
    });
    expect((err as Error).message).toContain(RECORD);
    expect((err as Error).message).toContain(VALUE);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("treats an absent record as a miss, not a server error", async () => {
    resolveTxt.mockRejectedValue(
      Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(
      orgSsoVerifyDomainHandler({ providerId: "acme" }, CTX),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "dns_record_not_found",
    });
  });

  it("rethrows a resolver failure that is not an absent record", async () => {
    resolveTxt.mockRejectedValue(
      Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" }),
    );
    await expect(
      orgSsoVerifyDomainHandler({ providerId: "acme" }, CTX),
    ).rejects.toThrow(/ETIMEOUT/);
  });

  it("reads a provider of another organisation as not found", async () => {
    mocks.find.mockResolvedValue(null);
    await expect(
      orgSsoVerifyDomainHandler({ providerId: "acme" }, CTX),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(resolveTxt).not.toHaveBeenCalled();
  });

  it("does not write or audit again for a domain already verified", async () => {
    mocks.find.mockResolvedValue(ssoRow({ domainVerified: true }));
    resolveTxt.mockResolvedValue([[VALUE]]);
    const out = await orgSsoVerifyDomainHandler({ providerId: "acme" }, CTX);
    expect(out.provider.domainVerified).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
