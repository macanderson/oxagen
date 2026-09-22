import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  list: vi.fn(),
  listRoles: vi.fn(),
  readRequired: vi.fn(),
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
  listOrgSsoProviders: mocks.list,
  listOrgSsoGroupRoles: mocks.listRoles,
  readOrgSsoRequired: mocks.readRequired,
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

import { orgSsoListHandler } from "./org.sso.list";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { SSO_BASE_URL, ssoRow } from "./test-utils/sso-fixtures";

const SAML_ROW = ssoRow({
  providerId: "acme-saml",
  protocol: "saml",
  issuer: "urn:acme",
  oidcConfig: null,
  samlConfig: JSON.stringify({
    entryPoint: "https://idp.acme.com/sso",
    privateKey: "enc:v1:sso_v1:a2V5",
    spMetadata: { entityID: "x", privateKey: "enc:v1:sso_v1:a2V5" },
  }),
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
  plan.resolveOrgTier.mockReset().mockResolvedValue("enterprise");
  process.env.BETTER_AUTH_URL = SSO_BASE_URL;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
  mocks.list.mockResolvedValue([ssoRow(), SAML_ROW]);
  mocks.listRoles.mockResolvedValue([
    { providerId: "acme", idpGroup: "eng", role: "member" },
    { providerId: "acme-saml", idpGroup: "ops", role: "admin" },
  ]);
  mocks.readRequired.mockResolvedValue(true);
});

describe("org.sso.list handler", () => {
  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(orgSsoListHandler({}, CTX)).rejects.toThrow(/forbidden/);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("reports the organisation as entitled on the Enterprise plan", async () => {
    const out = await orgSsoListHandler({}, CTX);
    expect(out.entitled).toBe(true);
    expect(plan.resolveOrgTier).toHaveBeenCalledWith(CTX.orgId);
  });

  it("still lists providers for an organisation that left the Enterprise plan, and says so", async () => {
    plan.resolveOrgTier.mockResolvedValue("scale");
    const out = await orgSsoListHandler({}, CTX);
    expect(out.entitled).toBe(false);
    expect(out.providers.map((p) => p.providerId)).toEqual([
      "acme",
      "acme-saml",
    ]);
    expect(out.policy).toEqual({ ssoRequired: true });
  });

  it("reads only the caller's organisation", async () => {
    await orgSsoListHandler({}, CTX);
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), CTX.orgId);
    expect(mocks.listRoles).toHaveBeenCalledWith(expect.anything(), CTX.orgId, [
      "acme",
      "acme-saml",
    ]);
    expect(mocks.readRequired).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
    );
  });

  it("returns each provider with its own group roles, URLs and the policy", async () => {
    const out = await orgSsoListHandler({}, CTX);
    expect(out.policy).toEqual({ ssoRequired: true });
    const [oidc, saml] = out.providers;
    expect(oidc).toMatchObject({
      providerId: "acme",
      callbackUrl: `${SSO_BASE_URL}/api/auth/sso/callback/acme`,
      spMetadataUrl: null,
      domainVerification: {
        recordName: "_oxagen-sso.acme.com",
        recordValue: "oxagen-sso-verification=tok123",
      },
      oidc: {
        clientId: "client-1",
        clientSecretSet: true,
        scopes: ["openid", "email", "profile"],
      },
      saml: null,
      groupRoles: [{ group: "eng", role: "member" }],
      createdAt: "2026-09-22T12:00:00.000Z",
    });
    expect(saml).toMatchObject({
      providerId: "acme-saml",
      callbackUrl: `${SSO_BASE_URL}/api/auth/sso/saml2/sp/acs/acme-saml`,
      spMetadataUrl: `${SSO_BASE_URL}/api/auth/sso/saml2/sp/metadata?providerId=acme-saml`,
      saml: { entryPoint: "https://idp.acme.com/sso", spPrivateKeySet: true },
      oidc: null,
      groupRoles: [{ group: "ops", role: "admin" }],
    });
  });

  it("never returns a sealed or plain secret", async () => {
    const out = await orgSsoListHandler({}, CTX);
    expect(JSON.stringify(out)).not.toContain("enc:v1:");
  });

  it("emits no audit row for a read", async () => {
    await orgSsoListHandler({}, CTX);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
