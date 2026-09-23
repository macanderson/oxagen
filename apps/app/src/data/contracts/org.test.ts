// The ApiKey view model is the boundary the API keys page reads through
// (ARCHITECTURE.md §3.4): nothing that could be exchanged for access may cross
// it. list_api_keys returns no secret and no hash today; these tests hold the
// view model to that whatever the contract grows, by naming every field it
// carries and by proving an unrecognised field does not survive the parse.
import { GOVERNANCE_MODES as CONTRACT_GOVERNANCE_MODES } from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  SSO_MAPPABLE_ROLES,
  ssoProtocolSchema,
} from "@oxagen/oxagen/contracts/org.sso.shared";
import { describe, expect, it } from "vitest";
import {
  ApiKey,
  ApiKeyList,
  GOVERNANCE_MODES,
  SsoMappableRole,
  SsoProtocol,
  SsoProvider,
} from "./org";

const SECRET_SHAPED = /secret|hash|token|key$/i;

const stored = {
  id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
  name: "CI runner",
  prefix: "ox_liveliveli",
  createdAt: "2026-09-13T10:00:00.000Z",
  lastUsedAt: "2026-09-14T11:30:00.000Z",
  expiresAt: null,
  revokedAt: null,
  rotatable: true,
};

describe("ApiKey", () => {
  it("carries the key's metadata and no field named like a secret or a hash", () => {
    expect(Object.keys(ApiKey.shape)).toEqual([
      "id",
      "name",
      "prefix",
      "createdAt",
      "lastUsedAt",
      "expiresAt",
      "revokedAt",
      "rotatable",
    ]);
    expect(
      Object.keys(ApiKey.shape).filter((f) => SECRET_SHAPED.test(f)),
    ).toEqual([]);
  });

  it("drops a field it does not name, so a secret the contract grows cannot reach the page (negative)", () => {
    const parsed = ApiKey.parse({
      ...stored,
      keyHash: "sha256-of-the-live-key",
      secret: "ox_thewholekey",
    });
    expect(Object.keys(parsed)).toEqual(Object.keys(ApiKey.shape));
    expect(JSON.stringify(parsed)).not.toContain("sha256-of-the-live-key");
    expect(JSON.stringify(parsed)).not.toContain("ox_thewholekey");
  });

  it("refuses a raw database id in place of the key's public id (negative)", () => {
    expect(
      ApiKeyList.safeParse([
        { ...stored, id: "7a000000-0000-4000-8000-0000000000a1" },
      ]).success,
    ).toBe(false);
  });

  it("refuses an instant that is not a timestamp (negative)", () => {
    expect(
      ApiKeyList.safeParse([{ ...stored, createdAt: "yesterday" }]).success,
    ).toBe(false);
  });
});

// The SSO view model holds to the same rule: a stored client secret or SP key
// is reported as set, and a secret the contract might grow does not survive
// the parse. Its role and protocol sets mirror the shared contract, so the
// group-mapping editor can offer no role the contract refuses.
describe("SsoProvider", () => {
  const provider = {
    providerRef: "acme-okta",
    displayName: "Acme Okta",
    protocol: "oidc",
    domain: "acme.com",
    domainVerified: true,
    issuer: "https://acme.okta.com",
    groupsClaim: "groups",
    verification: {
      recordName: "_oxagen-sso.acme.com",
      recordValue: "oxagen-sso-verification=4f9d2c7a",
    },
    callbackUrl: "https://app.oxagen.sh/api/auth/sso/callback/acme-okta",
    spMetadataUrl: null,
    oidc: { clientRef: "0oa1b2c3d4", clientSecretSet: true },
    saml: null,
    groupRoles: [],
  };

  it("drops a secret the contract might grow (negative)", () => {
    const parsed = SsoProvider.parse({
      ...provider,
      clientSecret: "shh",
      oidc: { ...provider.oidc, clientSecret: "shh" },
    });
    expect(JSON.stringify(parsed)).not.toContain("shh");
  });

  it("refuses a group mapped to owner (negative)", () => {
    expect(
      SsoProvider.safeParse({
        ...provider,
        groupRoles: [{ group: "admins", role: "owner" }],
      }).success,
    ).toBe(false);
  });

  it("mirrors the contract's mappable roles and protocols", () => {
    expect([...SsoMappableRole.options]).toEqual([...SSO_MAPPABLE_ROLES]);
    expect([...SsoProtocol.options].sort()).toEqual(
      [...ssoProtocolSchema.options].sort(),
    );
  });
});

// The workspace dialog is a client component, and no client module in this
// app imports a kernel contract module (#3521). The modes are mirrored in
// `./org`, and this case keeps the mirror equal to the contract, in order.
describe("org contract mirrors", () => {
  it("mirrors the governance modes, loosest to strictest", () => {
    expect([...GOVERNANCE_MODES]).toEqual([...CONTRACT_GOVERNANCE_MODES]);
  });
});
