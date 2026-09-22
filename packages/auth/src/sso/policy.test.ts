/**
 * Unit tests for the sign-in side of "Require SSO" (./policy.ts).
 *
 * withSystemDb is mocked; each call answers from a per-test queue in order:
 * first the lookup for an SSO-required organisation owning the email domain,
 * then the Owner lookup. The invariant under test is the break-glass rule:
 * a password or social sign-in into an SSO-required organisation is refused
 * for everyone except its Owners.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { withSystemDbMock, calls } = vi.hoisted(() => ({
  withSystemDbMock: vi.fn(),
  calls: [] as { method: string; args: unknown[] }[][],
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) => withSystemDbMock(fn),
  schema: {
    ssoProviderTable: {
      organizationId: "ssoProviderTable.organizationId",
      domain: "ssoProviderTable.domain",
      domainVerified: "ssoProviderTable.domainVerified",
    },
    orgSecurityPolicy: {
      orgId: "orgSecurityPolicy.orgId",
      ssoRequired: "orgSecurityPolicy.ssoRequired",
    },
    orgUsers: {
      orgId: "orgUsers.orgId",
      userId: "orgUsers.userId",
      role: "orgUsers.role",
    },
    users: { id: "users.id", email: "users.email" },
  },
}));

const { orgHasSso } = vi.hoisted(() => ({
  orgHasSso: vi.fn(async () => true),
}));
vi.mock("./entitlement", () => ({ orgHasSso }));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

import { candidateDomains, emailDomain, isNonSsoSignInRefused } from "./policy";

/** Each withSystemDb call records its chain and resolves the next answer. */
function answer(...results: unknown[][]) {
  withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) => {
    const chain: { method: string; args: unknown[] }[] = [];
    calls.push(chain);
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "from", "innerJoin", "where", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        chain.push({ method: m, args });
        return builder;
      };
    }
    const result = results.shift();
    if (!result) throw new Error("unexpected withSystemDb call");
    builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return fn(builder);
  });
}

const whereOf = (i: number) =>
  (calls[i]!.find((c) => c.method === "where")!.args[0] as { and: unknown[] })
    .and;

beforeEach(() => {
  withSystemDbMock.mockReset();
  calls.length = 0;
});

describe("emailDomain", () => {
  it.each([
    ["ada@example.com", "example.com"],
    ["Ada@Example.COM", "example.com"],
    ["ada@example.com ", "example.com"],
    // The last @ wins, so a quoted local part cannot smuggle a domain.
    ['"a@evil.com"@example.com', "example.com"],
    ["ada@sub.example.co.uk", "sub.example.co.uk"],
  ])("%s -> %s", (email, domain) => {
    expect(emailDomain(email)).toBe(domain);
  });

  it.each([["no-at-sign"], ["@example.com"], ["ada@"], [""]])(
    "%j is malformed",
    (email) => {
      expect(emailDomain(email)).toBeNull();
    },
  );
});

describe("isNonSsoSignInRefused", () => {
  it("allows a malformed address without touching the database", async () => {
    await expect(isNonSsoSignInRefused("not-an-email")).resolves.toBe(false);
    expect(withSystemDbMock).not.toHaveBeenCalled();
  });

  it("allows a domain no SSO-required organisation owns", async () => {
    answer([]);
    await expect(isNonSsoSignInRefused("ada@example.com")).resolves.toBe(false);
    expect(withSystemDbMock).toHaveBeenCalledTimes(1);
    // Only a verified domain on an organisation that requires SSO counts.
    expect(whereOf(0)).toEqual([
      { inArray: ["ssoProviderTable.domain", ["example.com"]] },
      { eq: ["ssoProviderTable.domainVerified", true] },
      { eq: ["orgSecurityPolicy.ssoRequired", true] },
    ]);
  });

  it("covers a subdomain of an SSO-required domain", async () => {
    answer([{ orgId: "org_1" }], []);
    await expect(isNonSsoSignInRefused("ada@eng.example.com")).resolves.toBe(
      true,
    );
    expect(whereOf(0)).toContainEqual({
      inArray: ["ssoProviderTable.domain", ["eng.example.com", "example.com"]],
    });
  });

  it("refuses a non-Owner of the SSO-required organisation", async () => {
    answer([{ orgId: "org_1" }], []);
    await expect(isNonSsoSignInRefused("ada@example.com")).resolves.toBe(true);
  });

  it("stops applying once the organisation's plan lacks SSO", async () => {
    orgHasSso.mockResolvedValueOnce(false);
    answer([{ orgId: "org_1" }]);
    await expect(isNonSsoSignInRefused("ada@example.com")).resolves.toBe(false);
    expect(orgHasSso).toHaveBeenCalledWith("org_1");
    // The Owner lookup never runs.
    expect(withSystemDbMock).toHaveBeenCalledTimes(1);
  });

  it("lets an Owner through as the break-glass account", async () => {
    answer([{ orgId: "org_1" }], [{ role: "owner" }]);
    await expect(isNonSsoSignInRefused("ada@example.com")).resolves.toBe(false);
    expect(whereOf(1)).toEqual([
      { eq: ["orgUsers.orgId", "org_1"] },
      { eq: ["users.email", "ada@example.com"] },
      { inArray: ["orgUsers.role", ["owner", "Owner"]] },
    ]);
  });

  it("normalises the typed email before the Owner lookup", async () => {
    answer([{ orgId: "org_1" }], [{ role: "Owner" }]);
    await expect(isNonSsoSignInRefused("  Ada@Example.COM ")).resolves.toBe(
      false,
    );
    expect(whereOf(0)).toContainEqual({
      inArray: ["ssoProviderTable.domain", ["example.com"]],
    });
    expect(whereOf(1)).toContainEqual({
      eq: ["users.email", "ada@example.com"],
    });
  });
});

describe("candidateDomains", () => {
  it("lists the domain and its parents, never a bare top-level domain", () => {
    expect(candidateDomains("eng.acme.co.uk")).toEqual([
      "eng.acme.co.uk",
      "acme.co.uk",
      "co.uk",
    ]);
    expect(candidateDomains("acme.com")).toEqual(["acme.com"]);
    expect(candidateDomains("localhost")).toEqual([]);
  });
});
