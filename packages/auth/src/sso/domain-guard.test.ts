import { describe, expect, it, vi } from "vitest";
import { createSsoDomainGuard, emailInSsoDomain } from "./domain-guard";

const providers: Record<string, { domain: string; domainVerified: boolean }> = {
  acme: { domain: "acme.com", domainVerified: true },
  pending: { domain: "pending.io", domainVerified: false },
};

function guard() {
  const lookupProvider = vi.fn(async (id: string) => providers[id] ?? null);
  return { lookupProvider, g: createSsoDomainGuard({ lookupProvider }) };
}

const sso = (providerId?: string) => ({
  path: "/sso/callback/:providerId",
  params: providerId === undefined ? {} : { providerId },
});

describe("emailInSsoDomain", () => {
  it.each([
    ["ada@acme.com", "acme.com", true],
    ["ada@eng.acme.com", "acme.com", true],
    ["ADA@Acme.COM", "acme.com", true],
    ["ada@evilacme.com", "acme.com", false],
    ["ada@acme.com.evil.io", "acme.com", false],
    ["victim@gmail.com", "acme.com", false],
    ["not-an-email", "acme.com", false],
  ])("%s in %s → %s", (email, domain, expected) => {
    expect(emailInSsoDomain(email, domain)).toBe(expected);
  });
});

describe("userCreateBefore", () => {
  it("lets an in-domain SSO user be created", async () => {
    const { g } = guard();
    expect(
      await g.userCreateBefore({ email: "ada@acme.com" }, sso("acme")),
    ).toBeUndefined();
  });

  it("refuses an email outside the provider's domain (account pre-hijack)", async () => {
    const { g } = guard();
    expect(
      await g.userCreateBefore({ email: "victim@gmail.com" }, sso("acme")),
    ).toBe(false);
  });

  it("refuses when the provider's domain is not verified", async () => {
    const { g } = guard();
    expect(
      await g.userCreateBefore({ email: "ada@pending.io" }, sso("pending")),
    ).toBe(false);
  });

  it("refuses an unknown provider and an SSO path with no provider id", async () => {
    const { g } = guard();
    expect(
      await g.userCreateBefore({ email: "ada@acme.com" }, sso("nope")),
    ).toBe(false);
    expect(await g.userCreateBefore({ email: "ada@acme.com" }, sso())).toBe(
      false,
    );
  });

  it("covers the SAML ACS path", async () => {
    const { g } = guard();
    expect(
      await g.userCreateBefore(
        { email: "victim@gmail.com" },
        {
          path: "/sso/saml2/sp/acs/:providerId",
          params: { providerId: "acme" },
        },
      ),
    ).toBe(false);
  });

  it("does not touch sign-ups that are not SSO", async () => {
    const { g, lookupProvider } = guard();
    expect(
      await g.userCreateBefore(
        { email: "x@gmail.com" },
        { path: "/sign-up/email" },
      ),
    ).toBeUndefined();
    expect(
      await g.userCreateBefore({ email: "x@gmail.com" }, null),
    ).toBeUndefined();
    expect(lookupProvider).not.toHaveBeenCalled();
  });
});

describe("accountCreateBefore", () => {
  const ctx = (email: string | null) => ({
    context: {
      internalAdapter: {
        findUserById: vi.fn(async () => (email === null ? null : { email })),
      },
    },
  });

  it("passes accounts of providers that are not SSO providers", async () => {
    const { g } = guard();
    expect(
      await g.accountCreateBefore(
        { providerId: "google", userId: "u1" },
        ctx("x@gmail.com"),
      ),
    ).toBeUndefined();
  });

  it("attaches an SSO account to an in-domain user", async () => {
    const { g } = guard();
    expect(
      await g.accountCreateBefore(
        { providerId: "acme", userId: "u1" },
        ctx("ada@acme.com"),
      ),
    ).toBeUndefined();
  });

  it("refuses to attach an SSO account to an out-of-domain user", async () => {
    const { g } = guard();
    expect(
      await g.accountCreateBefore(
        { providerId: "acme", userId: "u1" },
        ctx("victim@gmail.com"),
      ),
    ).toBe(false);
  });

  it("refuses when the user cannot be read, or the domain is unverified", async () => {
    const { g } = guard();
    expect(
      await g.accountCreateBefore(
        { providerId: "acme", userId: "u1" },
        ctx(null),
      ),
    ).toBe(false);
    expect(
      await g.accountCreateBefore({ providerId: "acme" }, ctx("ada@acme.com")),
    ).toBe(false);
    expect(
      await g.accountCreateBefore(
        { providerId: "pending", userId: "u1" },
        ctx("ada@pending.io"),
      ),
    ).toBe(false);
  });

  it("passes an account with no provider id", async () => {
    const { g } = guard();
    expect(await g.accountCreateBefore({ userId: "u1" }, null)).toBeUndefined();
  });
});
