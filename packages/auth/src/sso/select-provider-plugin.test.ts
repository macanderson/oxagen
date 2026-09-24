/**
 * The /sign-in/sso provider selection (#3740).
 *
 * On a domain miss the SSO plugin lists every provider. The adapter no longer
 * opens secrets in a listing, so this hook must name the provider first. The
 * cases pin which provider it names, and one runs a real Better Auth instance
 * to prove a before hook's body change reaches the endpoint.
 */
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthEndpoint } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { withSystemDbMock, chain } = vi.hoisted(() => ({
  withSystemDbMock: vi.fn(),
  chain: [] as { method: string; args: unknown[] }[],
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) => withSystemDbMock(fn),
  schema: {
    ssoProviderTable: {
      providerId: "ssoProviderTable.providerId",
      domain: "ssoProviderTable.domain",
      domainVerified: "ssoProviderTable.domainVerified",
      oidcConfig: "ssoProviderTable.oidcConfig",
    },
  },
}));
vi.mock("./entitlement", () => ({ orgHasSso: vi.fn(async () => true) }));
vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

import {
  pgVerifiedSsoProviderLookup,
  routingDomain,
  selectSsoProviderPlugin,
  selectVerifiedSsoProvider,
  type VerifiedSsoProviderLookup,
} from "./select-provider-plugin";

interface ProviderRow {
  providerId: string;
  domain: string;
  domainVerified: boolean;
}

/** The lookup's contract over an in-memory table: verified rows in `domains`. */
function memoryLookup(rows: ProviderRow[]): VerifiedSsoProviderLookup {
  return async (domains) =>
    rows
      .filter((r) => r.domainVerified && domains.includes(r.domain))
      .map(({ providerId, domain }) => ({ providerId, domain }));
}

describe("selectVerifiedSsoProvider", () => {
  it("routes a subdomain email to the verified parent provider", async () => {
    const lookup = memoryLookup([
      { providerId: "acme", domain: "acme.com", domainVerified: true },
    ]);
    await expect(
      selectVerifiedSsoProvider("sub.acme.com", lookup),
    ).resolves.toBe("acme");
  });

  it("picks the more specific verified provider when both match", async () => {
    const lookup = memoryLookup([
      { providerId: "acme", domain: "acme.com", domainVerified: true },
      { providerId: "acme-eng", domain: "eng.acme.com", domainVerified: true },
    ]);
    await expect(
      selectVerifiedSsoProvider("dev.eng.acme.com", lookup),
    ).resolves.toBe("acme-eng");
    await expect(selectVerifiedSsoProvider("acme.com", lookup)).resolves.toBe(
      "acme",
    );
  });

  it("ignores an unverified provider, even a more specific one", async () => {
    const lookup = memoryLookup([
      { providerId: "acme", domain: "acme.com", domainVerified: true },
      { providerId: "squatter", domain: "sub.acme.com", domainVerified: false },
    ]);
    await expect(
      selectVerifiedSsoProvider("sub.acme.com", lookup),
    ).resolves.toBe("acme");
    const none = memoryLookup([
      { providerId: "squatter", domain: "acme.com", domainVerified: false },
    ]);
    await expect(
      selectVerifiedSsoProvider("sub.acme.com", none),
    ).resolves.toBeNull();
  });

  it("never asks about a bare top-level domain", async () => {
    const lookup = vi.fn(async () => []);
    await selectVerifiedSsoProvider("sub.acme.com", lookup);
    expect(lookup).toHaveBeenCalledWith(["sub.acme.com", "acme.com"]);
    await expect(selectVerifiedSsoProvider("com", lookup)).resolves.toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe("pgVerifiedSsoProviderLookup", () => {
  beforeEach(() => {
    chain.length = 0;
    withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "from", "where"]) {
        builder[m] = (...args: unknown[]) => {
          chain.push({ method: m, args });
          return m === "where" ? Promise.resolve([]) : builder;
        };
      }
      return fn(builder);
    });
  });

  it("selects only the id and domain of verified providers in the candidate domains", async () => {
    await pgVerifiedSsoProviderLookup(["sub.acme.com", "acme.com"]);
    expect(chain.find((c) => c.method === "select")?.args[0]).toEqual({
      providerId: "ssoProviderTable.providerId",
      domain: "ssoProviderTable.domain",
    });
    expect(chain.find((c) => c.method === "where")?.args[0]).toEqual({
      and: [
        {
          inArray: ["ssoProviderTable.domain", ["sub.acme.com", "acme.com"]],
        },
        { eq: ["ssoProviderTable.domainVerified", true] },
      ],
    });
  });
});

describe("routingDomain", () => {
  it("routes by the email's domain, or by an explicit domain first", () => {
    expect(routingDomain({ email: "Ada@Sub.Acme.com" })).toBe("sub.acme.com");
    expect(routingDomain({ email: "a@x.com", domain: "Acme.com" })).toBe(
      "acme.com",
    );
  });

  it("leaves a body that already names a provider or an organisation alone", () => {
    expect(routingDomain({ email: "a@acme.com", providerId: "p" })).toBeNull();
    expect(
      routingDomain({ email: "a@acme.com", organizationSlug: "acme" }),
    ).toBeNull();
    expect(routingDomain({ email: "not-an-email" })).toBeNull();
    expect(routingDomain(undefined)).toBeNull();
  });
});

describe("selectSsoProviderPlugin in Better Auth", () => {
  // A stand-in for the SSO plugin's endpoint that reports the body it got.
  const echo: BetterAuthPlugin = {
    id: "echo-sign-in-sso",
    endpoints: {
      signInSSO: createAuthEndpoint(
        "/sign-in/sso",
        { method: "POST" },
        async (ctx) => ctx.json({ body: ctx.body }),
      ),
    },
  };

  async function post(lookup: VerifiedSsoProviderLookup, body: object) {
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-that-is-at-least-thirty-two-characters",
      database: memoryAdapter({ user: [], session: [], account: [] }),
      plugins: [selectSsoProviderPlugin({ lookup }), echo],
    });
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/sso", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { body: Record<string, unknown> }).body;
  }

  const lookup = memoryLookup([
    { providerId: "acme", domain: "acme.com", domainVerified: true },
  ]);

  it("writes the selected provider id into the body the endpoint reads", async () => {
    const body = await post(lookup, {
      email: "ada@sub.acme.com",
      callbackURL: "/acme",
    });
    expect(body).toEqual({
      email: "ada@sub.acme.com",
      callbackURL: "/acme",
      providerId: "acme",
    });
  });

  it("leaves an explicit providerId untouched", async () => {
    const spy = vi.fn(lookup);
    const body = await post(spy, {
      email: "ada@sub.acme.com",
      providerId: "chosen",
    });
    expect(body.providerId).toBe("chosen");
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves the body alone when no verified provider matches", async () => {
    const body = await post(lookup, { email: "ada@other.com" });
    expect(body).toEqual({ email: "ada@other.com" });
  });
});
