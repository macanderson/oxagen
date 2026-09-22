import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  resolveKms: vi.fn(),
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
vi.mock("@oxagen/database/sso-secrets", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@oxagen/database/sso-secrets")>();
  const { fakeSealSsoConfig } = await import("./test-utils/sso-fixtures");
  return {
    ...real,
    resolveSsoKms: mocks.resolveKms,
    sealSsoConfig: (
      protocol: "oidc" | "saml",
      config: Record<string, unknown>,
    ) => fakeSealSsoConfig(real.SSO_SECRET_PATHS[protocol], config),
  };
});
vi.mock("./lib/sso-store", () => ({
  findOrgSsoProvider: mocks.find,
  updateOrgSsoProvider: mocks.update,
  listOrgSsoGroupRoles: mocks.listRoles,
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

import { plaintextSsoSecretPaths } from "@oxagen/database/sso-secrets";
import { orgSsoUpdateHandler } from "./org.sso.update";
import { setSsoDiscoveryFetchForTests } from "./lib/sso";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import {
  discoveryDoc,
  ISSUER,
  jsonResponse,
  SSO_BASE_URL,
  ssoRow,
} from "./test-utils/sso-fixtures";

const STORED_SECRET = "enc:v1:sso_v1:c3RvcmVk";
const discoveryFetch = vi.fn();

function patch(): Record<string, unknown> {
  return mocks.update.mock.calls[0]![3] as Record<string, unknown>;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
  process.env.BETTER_AUTH_URL = SSO_BASE_URL;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
  mocks.resolveKms.mockReturnValue({ adapter: {}, keyId: "sso_v1" });
  mocks.find.mockResolvedValue(ssoRow());
  mocks.update.mockImplementation(async (_tx, _org, _pid, p) => ({
    ...ssoRow(),
    ...p,
  }));
  mocks.listRoles.mockResolvedValue([
    { providerId: "acme", idpGroup: "eng", role: "member" },
  ]);
  discoveryFetch.mockReset();
  discoveryFetch.mockImplementation(async () =>
    jsonResponse(
      discoveryDoc({
        issuer: "https://login.acme.com",
        authorization_endpoint: "https://login.acme.com/authorize",
        token_endpoint: "https://login.acme.com/token",
        jwks_uri: "https://login.acme.com/jwks",
        userinfo_endpoint: undefined,
      }),
    ),
  );
  setSsoDiscoveryFetchForTests(discoveryFetch);
});

afterEach(() => {
  setSsoDiscoveryFetchForTests(null);
});

describe("org.sso.update handler", () => {
  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(
      orgSsoUpdateHandler({ providerId: "acme", displayName: "X" }, CTX),
    ).rejects.toThrow(/forbidden/);
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(expect.anything(), {
      org: ["Owner", "Admin"],
    });
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("reads a provider of another organisation as not found", async () => {
    mocks.find.mockResolvedValue(null);
    await expect(
      orgSsoUpdateHandler({ providerId: "acme", displayName: "X" }, CTX),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "sso_provider_not_found",
    });
    expect(mocks.find).toHaveBeenCalledWith(
      expect.anything(),
      CTX.orgId,
      "acme",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("renames without touching the config, and audits the changed field", async () => {
    const out = await orgSsoUpdateHandler(
      { providerId: "acme", displayName: "Acme Corp" },
      CTX,
    );
    expect(patch()).toEqual({ displayName: "Acme Corp" });
    expect(out.provider.displayName).toBe("Acme Corp");
    expect(out.provider.groupRoles).toEqual([{ group: "eng", role: "member" }]);
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.provider_updated",
        capability: "update_sso_provider",
        detail: {
          providerId: "acme",
          protocol: "oidc",
          domain: "acme.com",
          changedFields: ["displayName"],
        },
      }),
    );
  });

  it("rewrites the groups mapping in the stored config when only the claim changes, with no KMS needed", async () => {
    mocks.resolveKms.mockReturnValue(null);
    await orgSsoUpdateHandler(
      { providerId: "acme", groupsClaim: "roles" },
      CTX,
    );
    const p = patch();
    expect(p["groupsClaim"]).toBe("roles");
    const config = JSON.parse(p["oidcConfig"] as string);
    expect(config.mapping.extraFields.groups).toBe("roles");
    expect(config.clientSecret).toBe(STORED_SECRET);
    expect(mocks.emit.mock.calls[0]![0].detail.changedFields).toEqual([
      "groupsClaim",
    ]);
  });

  it("keeps the stored sealed secret when the update leaves it out, without rediscovering an unchanged issuer", async () => {
    await orgSsoUpdateHandler(
      {
        providerId: "acme",
        config: {
          protocol: "oidc",
          issuer: `${ISSUER}/`,
          clientId: "client-2",
        },
      },
      CTX,
    );
    expect(discoveryFetch).not.toHaveBeenCalled();
    const config = JSON.parse(patch()["oidcConfig"] as string);
    expect(config.clientSecret).toBe(STORED_SECRET);
    expect(config.clientId).toBe("client-2");
    expect(config.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(config.mapping.extraFields.groups).toBe("groups");
  });

  it("seals a new secret and runs discovery again when the issuer changes", async () => {
    await orgSsoUpdateHandler(
      {
        providerId: "acme",
        config: {
          protocol: "oidc",
          issuer: "https://login.acme.com",
          clientId: "client-1",
          clientSecret: "brand-new-secret",
        },
      },
      CTX,
    );
    expect(discoveryFetch).toHaveBeenCalledTimes(1);
    const p = patch();
    expect(p["issuer"]).toBe("https://login.acme.com");
    const text = p["oidcConfig"] as string;
    expect(text).not.toContain("brand-new-secret");
    const config = JSON.parse(text);
    expect(plaintextSsoSecretPaths("oidc", config)).toEqual([]);
    expect(config.tokenEndpoint).toBe("https://login.acme.com/token");
    expect(config).not.toHaveProperty("userInfoEndpoint");
    expect(config.mapping.extraFields.groups).toBe("groups");
  });

  it("refuses a new issuer on a private address", async () => {
    await expect(
      orgSsoUpdateHandler(
        {
          providerId: "acme",
          config: {
            protocol: "oidc",
            issuer: "https://10.1.2.3",
            clientId: "c",
          },
        },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(discoveryFetch).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a protocol change", async () => {
    await expect(
      orgSsoUpdateHandler(
        {
          providerId: "acme",
          config: {
            protocol: "saml",
            issuer: "urn:x",
            entryPoint: "https://idp.acme.com/sso",
            cert: "c",
          },
        },
        CTX,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses a config change when no KMS is configured", async () => {
    mocks.resolveKms.mockReturnValue(null);
    await expect(
      orgSsoUpdateHandler(
        {
          providerId: "acme",
          config: { protocol: "oidc", issuer: ISSUER, clientId: "c" },
        },
        CTX,
      ),
    ).rejects.toThrow(/Refusing to store them in plaintext/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps a stored SAML SP key when the update leaves it out", async () => {
    const samlConfig = JSON.stringify({
      entryPoint: "https://idp.acme.com/sso",
      privateKey: "enc:v1:sso_v1:a2V5",
      spMetadata: { entityID: "x", privateKey: "enc:v1:sso_v1:a2V5" },
      mapping: { extraFields: { groups: "groups" } },
    });
    mocks.find.mockResolvedValue(
      ssoRow({
        protocol: "saml",
        oidcConfig: null,
        samlConfig,
        issuer: "urn:acme",
      }),
    );
    mocks.update.mockImplementation(async (_tx, _org, _pid, p) => ({
      ...ssoRow({ protocol: "saml", oidcConfig: null, samlConfig }),
      ...p,
    }));
    const out = await orgSsoUpdateHandler(
      {
        providerId: "acme",
        config: {
          protocol: "saml",
          issuer: "urn:acme",
          entryPoint: "https://idp.acme.com/sso2",
          cert: "cert",
        },
      },
      CTX,
    );
    const config = JSON.parse(patch()["samlConfig"] as string);
    expect(config.privateKey).toBe("enc:v1:sso_v1:a2V5");
    expect(config.spMetadata.privateKey).toBe("enc:v1:sso_v1:a2V5");
    expect(config.authnRequestsSigned).toBe(true);
    expect(config.entryPoint).toBe("https://idp.acme.com/sso2");
    expect(out.provider.saml).toEqual({
      entryPoint: "https://idp.acme.com/sso2",
      spPrivateKeySet: true,
    });
  });

  it("treats settings identical to the stored ones as no change", async () => {
    const input = {
      providerId: "acme",
      config: {
        protocol: "oidc" as const,
        issuer: ISSUER,
        clientId: "client-1",
      },
    };
    await orgSsoUpdateHandler(input, CTX);
    const rebuilt = patch()["oidcConfig"] as string;
    mocks.update.mockClear();
    mocks.emit.mockClear();
    mocks.find.mockResolvedValue(ssoRow({ oidcConfig: rebuilt }));
    await orgSsoUpdateHandler(input, CTX);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("writes and emits nothing when nothing changes", async () => {
    await orgSsoUpdateHandler({ providerId: "acme", displayName: "Acme" }, CTX);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
