// The single sign-on writes through the real kernel seam (INV-19): the viewer
// resolution and the kernel's invoke() are the only fakes, so each case shows
// what the person gets back and whether the capability ran.
//
// The cases the design turns on: an empty required field is refused beside
// that field before any capability runs; a secret left blank on an edit is
// left out, so the stored one stays; a SAML change travels with its
// certificate or is refused; the group table is sent whole; and the
// handlers' refusals arrive with the reason the page names.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  createSsoProvider,
  updateSsoProvider,
  deleteSsoProvider,
  verifySsoDomain,
  setSsoRequired,
  setSsoGroupRoles,
  createScimToken,
  rotateScimToken,
  revokeScimToken,
} = await import("./sso-actions");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const SECRET = "oidc-client-secret-0123456789";

const oidcDraft = {
  protocol: "oidc" as const,
  providerId: "acme-okta",
  displayName: "Acme Okta",
  domain: "acme.com",
  groupsClaim: "",
  issuer: "https://acme.okta.com",
  clientId: "0oa1b2c3d4",
  clientSecret: SECRET,
  entryPoint: "",
  cert: "",
  spPrivateKey: "",
};

const CERT = "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----";

const samlDraft = {
  ...oidcDraft,
  protocol: "saml" as const,
  providerId: "acme-entra",
  issuer: "https://sts.windows.net/acme/",
  clientId: "",
  clientSecret: "",
  entryPoint: "https://login.microsoftonline.com/acme/saml2",
  cert: CERT,
};

/** A provider view as the contracts answer it. */
const view = {
  providerId: "acme-okta",
  displayName: "Acme Okta",
  protocol: "oidc",
  domain: "acme.com",
  domainVerified: false,
  issuer: "https://acme.okta.com",
  groupsClaim: "groups",
  domainVerification: {
    recordName: "_oxagen-sso.acme.com",
    recordValue: "oxagen-sso-verification=4f9d2c7a",
  },
  callbackUrl: "https://app.oxagen.sh/api/auth/sso/callback/acme-okta",
  spMetadataUrl: null,
  oidc: { clientId: "0oa1b2c3d4", clientSecretSet: true, scopes: [] },
  saml: null,
  groupRoles: [],
  createdAt: "2026-09-22T10:00:00.000Z",
  updatedAt: "2026-09-22T10:00:00.000Z",
};

const refusal = (
  code: "forbidden" | "not_found" | "conflict",
  reason: string,
) => new kernel.HandlerError({ code, reason, message: `${code}: ${reason}` });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("createSsoProvider", () => {
  it("registers an OIDC provider, with the groups claim defaulted", async () => {
    invoke.mockResolvedValue({ provider: view });
    const out = await createSsoProvider("acme", oidcDraft);
    expect(out).toEqual({ ok: true, value: { providerId: "acme-okta" } });
    expect(invoke).toHaveBeenCalledWith(
      "create_sso_provider",
      {
        providerId: "acme-okta",
        displayName: "Acme Okta",
        domain: "acme.com",
        groupsClaim: "groups",
        config: {
          protocol: "oidc",
          issuer: "https://acme.okta.com",
          clientId: "0oa1b2c3d4",
          clientSecret: SECRET,
        },
      },
      expect.anything(),
    );
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("registers a SAML provider with its certificate and no SP key", async () => {
    invoke.mockResolvedValue({
      provider: { ...view, providerId: "acme-entra" },
    });
    await createSsoProvider("acme", { ...samlDraft, groupsClaim: "roles" });
    expect(invoke).toHaveBeenCalledWith(
      "create_sso_provider",
      expect.objectContaining({
        groupsClaim: "roles",
        config: {
          protocol: "saml",
          issuer: "https://sts.windows.net/acme/",
          entryPoint: "https://login.microsoftonline.com/acme/saml2",
          cert: CERT,
        },
      }),
      expect.anything(),
    );
  });

  it.each([
    ["providerId", { providerId: " " }, "provider_id_required"],
    ["displayName", { displayName: "" }, "display_name_required"],
    ["domain", { domain: "" }, "domain_required"],
    ["issuer", { issuer: "" }, "issuer_required"],
    ["clientId", { clientId: "" }, "client_id_required"],
    ["clientSecret", { clientSecret: "" }, "client_secret_required"],
  ] as const)(
    "refuses an OIDC draft with no %s before any capability runs (negative)",
    async (field, patch, code) => {
      const out = await createSsoProvider("acme", { ...oidcDraft, ...patch });
      expect(out).toEqual({ ok: false, reason: "invalid", code, field });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["entryPoint", { entryPoint: "" }, "entry_point_required"],
    ["cert", { cert: " " }, "cert_required"],
  ] as const)(
    "refuses a SAML draft with no %s before any capability runs (negative)",
    async (field, patch, code) => {
      const out = await createSsoProvider("acme", { ...samlDraft, ...patch });
      expect(out).toEqual({ ok: false, reason: "invalid", code, field });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("names a field the contract refused under config by the form's name for it (negative)", async () => {
    const out = await createSsoProvider("acme", {
      ...oidcDraft,
      issuer: "http://acme.okta.com",
    });
    expect(out).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "issuer",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes a taken domain through as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "domain_taken"));
    const out = await createSsoProvider("acme", oidcDraft);
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      code: "domain_taken",
    });
  });

  it("answers a role refusal as denied (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        "create_sso_provider",
        "authz_denied",
        "Forbidden",
      ),
    );
    const out = await createSsoProvider("acme", oidcDraft);
    expect(out).toMatchObject({ ok: false, reason: "denied" });
  });
});

describe("updateSsoProvider", () => {
  const stored = {
    issuer: "https://sts.windows.net/acme/",
    clientId: "",
    entryPoint: "https://login.microsoftonline.com/acme/saml2",
  };
  const oidcStored = {
    issuer: "https://acme.okta.com",
    clientId: "0oa1b2c3d4",
    entryPoint: "",
  };

  it("sends no OIDC settings on a rename, so nothing the form does not show is rewritten", async () => {
    invoke.mockResolvedValue({ provider: view });
    await updateSsoProvider("acme", {
      ...oidcDraft,
      displayName: "Okta",
      clientSecret: "",
      stored: oidcStored,
    });
    expect(invoke).toHaveBeenCalledWith(
      "update_sso_provider",
      { providerId: "acme-okta", displayName: "Okta", groupsClaim: "groups" },
      expect.anything(),
    );
  });

  it("sends a changed client ID and leaves the blank secret out, so the stored one stays", async () => {
    invoke.mockResolvedValue({ provider: view });
    await updateSsoProvider("acme", {
      ...oidcDraft,
      clientId: "0oa9z8y7",
      clientSecret: "",
      stored: oidcStored,
    });
    expect(invoke).toHaveBeenCalledWith(
      "update_sso_provider",
      {
        providerId: "acme-okta",
        displayName: "Acme Okta",
        groupsClaim: "groups",
        config: {
          protocol: "oidc",
          issuer: "https://acme.okta.com",
          clientId: "0oa9z8y7",
        },
      },
      expect.anything(),
    );
  });

  it("sends no SAML settings when nothing in them changed and no certificate was pasted", async () => {
    invoke.mockResolvedValue({ provider: view });
    await updateSsoProvider("acme", {
      ...samlDraft,
      displayName: "Entra",
      cert: "",
      stored,
    });
    expect(invoke).toHaveBeenCalledWith(
      "update_sso_provider",
      { providerId: "acme-entra", displayName: "Entra", groupsClaim: "groups" },
      expect.anything(),
    );
  });

  it("refuses a changed SSO URL with no certificate, rather than dropping it (negative)", async () => {
    const out = await updateSsoProvider("acme", {
      ...samlDraft,
      entryPoint: "https://login.microsoftonline.com/acme/saml3",
      cert: "",
      stored,
    });
    expect(out).toEqual({
      ok: false,
      reason: "invalid",
      code: "cert_required_for_change",
      field: "cert",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes a provider another admin removed through as not found (negative)", async () => {
    invoke.mockRejectedValue(refusal("not_found", "sso_provider_not_found"));
    const out = await updateSsoProvider("acme", {
      ...oidcDraft,
      stored: oidcStored,
    });
    expect(out).toEqual({
      ok: false,
      reason: "not_found",
      code: "sso_provider_not_found",
    });
  });
});

describe("deleteSsoProvider", () => {
  it("deletes the provider it names", async () => {
    invoke.mockResolvedValue({ deleted: true });
    const out = await deleteSsoProvider("acme", "acme-okta");
    expect(out).toEqual({ ok: true, value: { deleted: true } });
    expect(invoke).toHaveBeenCalledWith(
      "delete_sso_provider",
      { providerId: "acme-okta" },
      expect.anything(),
    );
  });
});

describe("verifySsoDomain", () => {
  it("answers whether the domain is now verified", async () => {
    invoke.mockResolvedValue({ provider: { ...view, domainVerified: true } });
    const out = await verifySsoDomain("acme", "acme-okta");
    expect(out).toEqual({ ok: true, value: { domainVerified: true } });
    expect(invoke).toHaveBeenCalledWith(
      "verify_sso_domain",
      { providerId: "acme-okta" },
      expect.anything(),
    );
  });

  it("passes a missing TXT record through as dns_record_not_found (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "dns_record_not_found"));
    const out = await verifySsoDomain("acme", "acme-okta");
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      code: "dns_record_not_found",
    });
  });
});

describe("setSsoRequired", () => {
  it("requires SSO", async () => {
    invoke.mockResolvedValue({ policy: { ssoRequired: true } });
    const out = await setSsoRequired("acme", true);
    expect(out).toEqual({ ok: true, value: { ssoRequired: true } });
    expect(invoke).toHaveBeenCalledWith(
      "set_sso_policy",
      { ssoRequired: true },
      expect.anything(),
    );
  });

  it("passes no_verified_provider through as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "no_verified_provider"));
    const out = await setSsoRequired("acme", true);
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      code: "no_verified_provider",
    });
  });
});

describe("setSsoGroupRoles", () => {
  it("sends the whole table, trimmed", async () => {
    invoke.mockResolvedValue({
      providerId: "acme-okta",
      mappings: [
        { group: "oxagen-admins", role: "admin" },
        { group: "finance", role: "billing" },
      ],
    });
    const out = await setSsoGroupRoles("acme", "acme-okta", [
      { group: " oxagen-admins ", role: "admin" },
      { group: "finance", role: "billing" },
    ]);
    expect(invoke).toHaveBeenCalledWith(
      "set_sso_group_roles",
      {
        providerId: "acme-okta",
        mappings: [
          { group: "oxagen-admins", role: "admin" },
          { group: "finance", role: "billing" },
        ],
      },
      expect.anything(),
    );
    expect(out.ok).toBe(true);
  });

  it("sends an empty table, which clears every mapping", async () => {
    invoke.mockResolvedValue({ providerId: "acme-okta", mappings: [] });
    await setSsoGroupRoles("acme", "acme-okta", []);
    expect(invoke).toHaveBeenCalledWith(
      "set_sso_group_roles",
      { providerId: "acme-okta", mappings: [] },
      expect.anything(),
    );
  });

  it("refuses a row with no group on that row before any capability runs (negative)", async () => {
    const out = await setSsoGroupRoles("acme", "acme-okta", [
      { group: "admins", role: "admin" },
      { group: " ", role: "member" },
    ]);
    expect(out).toEqual({
      ok: false,
      reason: "invalid",
      code: "group_required",
      field: "mappings.1.group",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a group named twice on the second row (negative)", async () => {
    const out = await setSsoGroupRoles("acme", "acme-okta", [
      { group: "admins", role: "admin" },
      { group: "admins ", role: "member" },
    ]);
    expect(out).toMatchObject({
      code: "group_duplicate",
      field: "mappings.1.group",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses owner at the contract, so no IdP group can mint an owner (negative)", async () => {
    const out = await setSsoGroupRoles("acme", "acme-okta", [
      // @ts-expect-error: owner is not a mappable role, and the contract says so too.
      { group: "admins", role: "owner" },
    ]);
    expect(out).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("SCIM token (#3734)", () => {
  const MINTED = {
    token: "oxscim_the-whole-token-value",
    baseUrl: "https://app.oxagen.sh/api/scim/v2",
    view: {
      tokenPrefix: "oxscim_the-whole",
      createdAt: "2026-09-23T10:00:00.000Z",
      lastUsedAt: null,
    },
  };

  it("mints a token and answers it once with the base URL", async () => {
    invoke.mockResolvedValue(MINTED);
    const out = await createScimToken("acme");
    expect(out).toEqual({
      ok: true,
      value: {
        token: MINTED.token,
        baseUrl: MINTED.baseUrl,
        prefix: "oxscim_the-whole",
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_scim_token",
      {},
      expect.anything(),
    );
  });

  it("passes scim_token_exists through as a conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "scim_token_exists"));
    const out = await createScimToken("acme");
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      code: "scim_token_exists",
    });
  });

  it("rotates the token", async () => {
    invoke.mockResolvedValue(MINTED);
    const out = await rotateScimToken("acme");
    expect(out.ok && out.value.token).toBe(MINTED.token);
    expect(invoke).toHaveBeenCalledWith(
      "rotate_scim_token",
      {},
      expect.anything(),
    );
  });

  it("revokes the token", async () => {
    invoke.mockResolvedValue({ revoked: true });
    await expect(revokeScimToken("acme")).resolves.toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(invoke).toHaveBeenCalledWith(
      "revoke_scim_token",
      {},
      expect.anything(),
    );
  });

  it("names the plan when minting is refused for it (negative)", async () => {
    invoke.mockRejectedValue(refusal("forbidden", "sso_requires_enterprise"));
    const out = await createScimToken("acme");
    expect(out).toEqual({
      ok: false,
      reason: "denied",
      code: "sso_requires_enterprise",
    });
  });
});
