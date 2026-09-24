/**
 * SSO sign-in, end to end, against a mock OIDC provider (ADR-145).
 *
 * This is the proof the feature works: a real Better Auth instance with the
 * SSO plugin exactly as auth.ts configures it (buildSsoPlugin, the disabled
 * paths, the secret-opening adapter wrapper, the auth-method session hook and
 * the real group → role provisioner) signs a person in through an identity
 * provider served over HTTP on a loopback port, and the person lands in the
 * role the mapping table grants.
 *
 * What is real: the plugin's sign-in and callback endpoints, PKCE, the state
 * cookie, the authorization-code exchange with client_secret_basic, ID-token
 * signature verification against the IdP's JWKS, the userinfo call, account
 * creation, the session and its cookie, the sealed client secret being opened
 * on read, and the provisioner's decision. What is faked: the IdP (a
 * node:http server minting RS256 tokens with jose), the database (Better
 * Auth's memory adapter), and the Postgres role write (an in-memory
 * SsoProvisioningStore; pg-store.ts is the production one).
 *
 * The mock IdP refuses the token request unless the client secret is the
 * plaintext one, so a wrapper that failed to open the sealed secret fails
 * this test at the exchange.
 *
 * It is a component-level proof, not a Playwright spec: apps/app/e2e holds
 * exactly login, pay and page-load (apps/app/ARCHITECTURE.md §6.3).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import {
  SSO_SECRET_KEY_ID,
  sealSsoConfig,
  type ResolvedSsoKms,
} from "@oxagen/database/sso-secrets";
import type { SsoGroupRole } from "@oxagen/oxagen/contracts/org.sso.shared";
import type { SecurityEventInput } from "@oxagen/telemetry";
import { withSsoSecrets } from "./adapter";
import { authMethodForPath } from "./auth-method";
import { SSO_DISABLED_PATHS, buildSsoPlugin } from "./plugin";
import { createSsoProvisioner, type SsoProvisioningStore } from "./provision";
import { createSsoDomainGuard } from "./domain-guard";

const BASE_URL = "http://localhost:3000";
const ORG_ID = "0e7d8a4c-2f55-4c1b-9d7e-5c1f7f0a2b11";
const CLIENT_ID = "oxagen-test-client";
const CLIENT_SECRET = "idp-client-secret-plaintext";
const AUTH_CODE = "authorization-code-123";
const ACCESS_TOKEN = "idp-access-token";

// ── Mock identity provider ───────────────────────────────────────────────────

interface IdpPerson {
  sub: string;
  email: string;
  name: string;
  groups: string[];
}

const idp = {
  server: null as Server | null,
  issuer: "",
  kid: "test-key-1",
  jwk: null as JWK | null,
  privateKey: null as CryptoKey | null,
  person: null as IdpPerson | null,
  /** The PKCE challenge the IdP saw at /authorize, checked at /token. */
  codeChallenge: null as string | null,
  tokenRequests: 0,
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function idToken(person: IdpPerson): Promise<string> {
  return new SignJWT({
    email: person.email,
    email_verified: true,
    name: person.name,
    groups: person.groups,
  })
    .setProtectedHeader({ alg: "RS256", kid: idp.kid })
    .setIssuer(idp.issuer)
    .setAudience(CLIENT_ID)
    .setSubject(person.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(idp.privateKey!);
}

function json(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleIdp(
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", idp.issuer);
  if (url.pathname === "/jwks") {
    return json(res, 200, { keys: [idp.jwk] });
  }
  if (url.pathname === "/token" && req.method === "POST") {
    idp.tokenRequests += 1;
    const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      return json(res, 401, { error: "invalid_client" });
    }
    const form = new URLSearchParams(await readBody(req));
    if (form.get("grant_type") !== "authorization_code") {
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (form.get("code") !== AUTH_CODE) {
      return json(res, 400, { error: "invalid_grant" });
    }
    const verifier = form.get("code_verifier") ?? "";
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    if (!idp.codeChallenge || challenge !== idp.codeChallenge) {
      return json(res, 400, {
        error: "invalid_grant",
        error_description: "pkce",
      });
    }
    return json(res, 200, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: await idToken(idp.person!),
    });
  }
  if (url.pathname === "/userinfo") {
    if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
      return json(res, 401, { error: "invalid_token" });
    }
    const p = idp.person!;
    return json(res, 200, {
      sub: p.sub,
      email: p.email,
      email_verified: true,
      name: p.name,
      groups: p.groups,
    });
  }
  json(res, 404, { error: "not_found" });
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  idp.privateKey = privateKey;
  idp.jwk = {
    ...(await exportJWK(publicKey)),
    kid: idp.kid,
    alg: "RS256",
    use: "sig",
  };
  idp.server = createServer((req, res) => {
    handleIdp(req, res).catch((err: unknown) => {
      json(res, 500, { error: String(err) });
    });
  });
  await new Promise<void>((resolve) =>
    idp.server!.listen(0, "127.0.0.1", resolve),
  );
  const { port } = idp.server.address() as AddressInfo;
  idp.issuer = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => idp.server?.close(() => resolve()));
});

// ── Oxagen side ──────────────────────────────────────────────────────────────

const kms: ResolvedSsoKms = {
  adapter: createLocalKmsAdapter(randomBytes(32)),
  keyId: SSO_SECRET_KEY_ID,
};

/** The OIDC config create_sso_provider stores, secrets sealed. */
async function storedOidcConfig(opts: {
  userInfo: boolean;
  clientSecret?: string;
}): Promise<string> {
  return sealSsoConfig(
    "oidc",
    {
      clientId: CLIENT_ID,
      clientSecret: opts.clientSecret ?? CLIENT_SECRET,
      authorizationEndpoint: `${idp.issuer}/authorize`,
      tokenEndpoint: `${idp.issuer}/token`,
      jwksEndpoint: `${idp.issuer}/jwks`,
      ...(opts.userInfo ? { userInfoEndpoint: `${idp.issuer}/userinfo` } : {}),
      tokenEndpointAuthentication: "client_secret_basic",
      scopes: ["openid", "email", "profile"],
      pkce: true,
      mapping: {
        id: "sub",
        email: "email",
        emailVerified: "email_verified",
        name: "name",
        image: "picture",
        extraFields: { groups: "groups" },
      },
    },
    kms,
  );
}

/** An in-memory stand-in for the org_users / IAM write in pg-store.ts. */
function memoryRoles(mappings: SsoGroupRole[], entitled = true) {
  const roles = new Map<string, string>();
  const key = (orgId: string, userId: string) => `${orgId}:${userId}`;
  const store: SsoProvisioningStore = {
    entitled: async () => entitled,
    groupRoles: async () => mappings,
    currentRole: async (orgId, userId) => roles.get(key(orgId, userId)) ?? null,
    applyRole: async ({ orgId, userId, role }) => {
      if (role === null) roles.delete(key(orgId, userId));
      else roles.set(key(orgId, userId), role);
    },
  };
  return { roles, store, key };
}

type Db = Record<string, Record<string, unknown>[]>;

async function buildAuth(opts: {
  mappings: SsoGroupRole[];
  userInfo?: boolean;
  clientSecret?: string;
  entitled?: boolean;
  seed?: (db: Db) => void;
}) {
  const db: Db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    ssoProvider: [
      {
        id: "prov-1",
        issuer: idp.issuer,
        oidcConfig: await storedOidcConfig({
          userInfo: opts.userInfo ?? true,
          clientSecret: opts.clientSecret,
        }),
        samlConfig: null,
        userId: "admin-user",
        providerId: "acme-okta",
        organizationId: ORG_ID,
        domain: "acme.com",
        domainVerified: true,
      },
    ],
  };
  opts.seed?.(db);
  const events: SecurityEventInput[] = [];
  const membership = memoryRoles(opts.mappings, opts.entitled ?? true);
  const guard = createSsoDomainGuard({
    lookupProvider: async (providerId) => {
      const row = db.ssoProvider!.find((p) => p.providerId === providerId);
      return row
        ? {
            domain: String(row.domain),
            domainVerified: row.domainVerified === true,
          }
        : null;
    },
  });
  const auth = betterAuth({
    baseURL: BASE_URL,
    // The mock IdP listens on 127.0.0.1. @better-auth/sso 1.6.33 refuses an
    // IdP endpoint on a private host unless its origin is trusted
    // (discovery_private_host), as an internal IdP must be.
    trustedOrigins: [idp.issuer],
    secret: "test-secret-that-is-at-least-thirty-two-characters",
    database: withSsoSecrets(memoryAdapter(db), () => kms),
    plugins: [
      buildSsoPlugin({
        provisionUser: createSsoProvisioner({
          store: membership.store,
          emit: (e) => events.push(e),
        }),
      }),
    ],
    disabledPaths: [...SSO_DISABLED_PATHS],
    session: {
      additionalFields: {
        authMethod: { type: "string", required: false, input: false },
      },
    },
    // The same domain guard auth.ts installs, reading the memory database.
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => guard.userCreateBefore(user, ctx),
        },
      },
      account: {
        create: {
          before: async (account, ctx) =>
            (await guard.accountCreateBefore(account, ctx)) === false
              ? false
              : undefined,
        },
      },
      session: {
        create: {
          before: async (session, ctx) => ({
            data: {
              ...session,
              authMethod: authMethodForPath(
                ctx?.path,
                ctx?.params as Record<string, unknown> | undefined,
              ),
            },
          }),
        },
      },
    },
    advanced: { cookiePrefix: "oxagen" },
  });
  return { auth, db, events, ...membership };
}

type Auth = Awaited<ReturnType<typeof buildAuth>>["auth"];

function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/**
 * Drive the browser's half of the flow: start SSO sign-in by email, let the
 * IdP "authenticate" the person, and follow the redirect back to Oxagen's
 * callback with the code and state. Returns the callback response.
 */
async function signInThroughIdp(auth: Auth, email: string): Promise<Response> {
  const start = await auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/sso`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, callbackURL: "/acme" }),
    }),
  );
  expect(start.status).toBe(200);
  const { url, redirect } = (await start.json()) as {
    url: string;
    redirect: boolean;
  };
  expect(redirect).toBe(true);

  const authorize = new URL(url);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(
    `${idp.issuer}/authorize`,
  );
  expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(authorize.searchParams.get("redirect_uri")).toBe(
    `${BASE_URL}/api/auth/sso/callback/acme-okta`,
  );
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  idp.codeChallenge = authorize.searchParams.get("code_challenge");
  const state = authorize.searchParams.get("state");
  expect(state).toBeTruthy();

  return auth.handler(
    new Request(
      `${BASE_URL}/api/auth/sso/callback/acme-okta?code=${AUTH_CODE}&state=${encodeURIComponent(state!)}`,
      { headers: { cookie: cookieHeader(start) } },
    ),
  );
}

async function sessionFrom(auth: Auth, res: Response) {
  const token = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("oxagen.session_token="));
  expect(token, "the callback must set a session cookie").toBeDefined();
  return auth.api.getSession({
    headers: new Headers({ cookie: token!.split(";")[0]! }),
  });
}

beforeEach(() => {
  idp.codeChallenge = null;
  idp.tokenRequests = 0;
  idp.person = {
    sub: "okta|00u1ada",
    email: "ada@acme.com",
    name: "Ada Lovelace",
    groups: ["Everyone", "oxagen-admins"],
  };
});

describe("SSO sign-in through a mock OIDC provider", () => {
  it("signs in and lands in the role the IdP group maps to", async () => {
    const { auth, db, events, roles, key } = await buildAuth({
      mappings: [
        { group: "oxagen-admins", role: "admin" },
        { group: "Everyone", role: "member" },
      ],
    });

    const callback = await signInThroughIdp(auth, "ada@acme.com");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/acme");
    expect(idp.tokenRequests).toBe(1);

    const session = await sessionFrom(auth, callback);
    expect(session?.user.email).toBe("ada@acme.com");
    expect(
      (session?.session as { authMethod?: string } | undefined)?.authMethod,
    ).toBe("sso:acme-okta");

    // The highest-ranked mapped role wins: admin over member.
    expect(roles.get(key(ORG_ID, session!.user.id))).toBe("admin");
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "sso.sign_in",
        orgId: ORG_ID,
        actorUserId: session!.user.id,
        outcome: "success",
        detail: {
          providerId: "acme-okta",
          groups: ["Everyone", "oxagen-admins"],
          grantedRole: "admin",
          previousRole: null,
          reason: "mapped",
        },
      }),
    ]);

    // The stored config never held the plaintext secret; the exchange above
    // only succeeded because the adapter wrapper opened it.
    expect(JSON.stringify(db.ssoProvider)).not.toContain(CLIENT_SECRET);
    expect(db.account).toEqual([
      expect.objectContaining({
        providerId: "acme-okta",
        accountId: "okta|00u1ada",
      }),
    ]);
  });

  it("reads groups from the verified ID token when the IdP has no userinfo endpoint", async () => {
    idp.person!.groups = ["finance"];
    const { auth, roles, key } = await buildAuth({
      mappings: [{ group: "finance", role: "billing" }],
      userInfo: false,
    });

    const callback = await signInThroughIdp(auth, "ada@acme.com");
    const session = await sessionFrom(auth, callback);

    expect(roles.get(key(ORG_ID, session!.user.id))).toBe("billing");
  });

  it("grants nothing when no group is mapped, and records the denial", async () => {
    idp.person!.groups = ["Everyone"];
    const { auth, events, roles } = await buildAuth({
      mappings: [{ group: "oxagen-admins", role: "admin" }],
    });

    const callback = await signInThroughIdp(auth, "ada@acme.com");
    const session = await sessionFrom(auth, callback);

    expect(roles.size).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "sso.sign_in",
        outcome: "deny",
        actorUserId: session!.user.id,
        detail: expect.objectContaining({
          grantedRole: null,
          reason: "no_mapped_group",
        }),
      }),
    ]);
  });

  it("removes a role the IdP no longer backs on the next sign-in", async () => {
    idp.person!.groups = ["Everyone"];
    const { auth, roles, key, events } = await buildAuth({
      mappings: [{ group: "oxagen-admins", role: "admin" }],
      seed: (db) => {
        db.user!.push({
          id: "user-ada",
          email: "ada@acme.com",
          name: "Ada Lovelace",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      },
    });
    roles.set(key(ORG_ID, "user-ada"), "admin");

    await signInThroughIdp(auth, "ada@acme.com");

    expect(roles.has(key(ORG_ID, "user-ada"))).toBe(false);
    expect(events[0]).toMatchObject({
      outcome: "deny",
      detail: { previousRole: "admin", grantedRole: null },
    });
  });

  it("never changes an Owner", async () => {
    idp.person!.groups = [];
    const { auth, roles, key, events } = await buildAuth({
      mappings: [],
      seed: (db) => {
        db.user!.push({
          id: "user-ada",
          email: "ada@acme.com",
          name: "Ada Lovelace",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      },
    });
    roles.set(key(ORG_ID, "user-ada"), "owner");

    await signInThroughIdp(auth, "ada@acme.com");

    expect(roles.get(key(ORG_ID, "user-ada"))).toBe("owner");
    expect(events[0]).toMatchObject({
      outcome: "success",
      detail: { reason: "owner_unmanaged" },
    });
  });

  it("refuses to start sign-in through a provider whose domain is not verified", async () => {
    const { auth, events } = await buildAuth({
      mappings: [{ group: "oxagen-admins", role: "admin" }],
      seed: (db) => {
        db.ssoProvider![0]!.domainVerified = false;
      },
    });

    const start = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "ada@acme.com", callbackURL: "/acme" }),
      }),
    );

    // An unproven domain claim must never send anyone to the claimant's IdP:
    // that is what stops one organisation signing in another's people.
    expect(start.status).toBe(401);
    expect(idp.tokenRequests).toBe(0);
    expect(events).toEqual([]);
  });

  it("refuses the callback when the domain lost its verification mid-flow", async () => {
    const { auth, db, events } = await buildAuth({
      mappings: [{ group: "oxagen-admins", role: "admin" }],
    });
    const start = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/sso`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email: "ada@acme.com", callbackURL: "/acme" }),
      }),
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorize = new URL(url);
    idp.codeChallenge = authorize.searchParams.get("code_challenge");
    const state = authorize.searchParams.get("state")!;

    db.ssoProvider![0]!.domainVerified = false;

    const callback = await auth.handler(
      new Request(
        `${BASE_URL}/api/auth/sso/callback/acme-okta?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`,
        { headers: { cookie: cookieHeader(start) } },
      ),
    );

    expect(
      callback.headers
        .getSetCookie()
        .some((c) => c.startsWith("oxagen.session_token=")),
    ).toBe(false);
    expect(idp.tokenRequests).toBe(0);
    expect(events).toEqual([]);
  });

  it.each([...SSO_DISABLED_PATHS])(
    "does not serve the plugin's own %s endpoint",
    async (path) => {
      const { auth, db } = await buildAuth({ mappings: [] });
      const before = JSON.stringify(db.ssoProvider);
      const res = await auth.handler(
        new Request(`${BASE_URL}/api/auth${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE_URL },
          body: JSON.stringify({
            providerId: "evil-idp",
            issuer: "https://evil.example",
            domain: "acme.com",
          }),
        }),
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(db.ssoProvider)).toBe(before);
    },
  );

  it("signs nobody in when the organisation's plan lacks SSO", async () => {
    const { auth, events, roles } = await buildAuth({
      mappings: [{ group: "oxagen-admins", role: "admin" }],
      entitled: false,
    });

    const callback = await signInThroughIdp(auth, "ada@acme.com");

    expect(
      callback.headers
        .getSetCookie()
        .some((c) => c.startsWith("oxagen.session_token=")),
    ).toBe(false);
    expect(roles.size).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "sso.sign_in",
        outcome: "deny",
        detail: expect.objectContaining({ reason: "not_entitled" }),
      }),
    ]);
  });

  it("creates no user when the IdP asserts an email outside the verified domain", async () => {
    // The pre-hijack: an org's own IdP asserts someone else's address.
    idp.person!.email = "victim@gmail.com";
    const { auth, db, events } = await buildAuth({
      mappings: [{ group: "oxagen-admins", role: "admin" }],
    });

    const callback = await signInThroughIdp(auth, "ada@acme.com");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=");
    expect(
      callback.headers
        .getSetCookie()
        .some((c) => c.startsWith("oxagen.session_token=")),
    ).toBe(false);
    expect(db.user).toEqual([]);
    expect(db.account).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses the exchange when the IdP rejects the client secret", async () => {
    const { auth, events } = await buildAuth({
      mappings: [{ group: "oxagen-admins", role: "admin" }],
      clientSecret: "not-the-secret-the-idp-issued",
    });

    const callback = await signInThroughIdp(auth, "ada@acme.com");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=");
    expect(
      callback.headers
        .getSetCookie()
        .some((c) => c.startsWith("oxagen.session_token=")),
    ).toBe(false);
    // Provisioning never ran: no role, no sign-in event.
    expect(events).toEqual([]);
  });
});
