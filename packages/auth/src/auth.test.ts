/**
 * Unit tests for auth.ts — import-time coverage + callback body coverage.
 *
 * Strategy
 * --------
 * 1. Mock every external dependency so importing auth.ts succeeds without a
 *    live DB, KMS, env-validation, or Better Auth runtime.
 * 2. The static `import { auth } from "./auth"` at the bottom of the mock
 *    section triggers module-level execution:
 *    – requireEnv() is called and the env constants are assigned.
 *    – The startup guard is evaluated (passes: NODE_ENV=test → isLocalEnv=true).
 *    – The entire betterAuth({...}) config literal is constructed, covering
 *      lines 231-541 in auth.ts.
 *    – All module-level statements are executed at import time.
 * 3. The captured betterAuth config is used to extract and invoke the callback
 *    functions (sendResetPassword, sendVerificationEmail, session.create.after,
 *    session.delete.after) so their bodies are covered.
 * 4. vi.resetModules() re-imports cover the startup-guard throw branch and
 *    the kmsAdapter creation branch (AUTH_TOKEN_ENCRYPTION_KEY set).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Capture target — hoisted via vi.hoisted() so it exists before vi.mock
// factories run (plain `let` in ESM is in TDZ until the declaration executes,
// which is too late for the hoisted mock factory).
// betterAuth() is called once at module-eval time of auth.ts; the mock factory
// stores the config object here so tests can extract and invoke the callbacks.
// ---------------------------------------------------------------------------
const capture = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
}));

const { TEST_BETTER_AUTH_URL } = vi.hoisted(() => ({
  TEST_BETTER_AUTH_URL: "https://app.oxagen.test",
}));

// ---------------------------------------------------------------------------
// All external dependency mocks — declared before any static import so vitest
// hoists them before auth.ts and its transitive deps are evaluated.
// ---------------------------------------------------------------------------

vi.mock("better-auth", () => ({
  betterAuth: (config: unknown) => {
    capture.config = config as Record<string, unknown>;
    return {
      api: { getSession: vi.fn().mockResolvedValue(null) },
      handler: vi.fn(),
    };
  },
}));

// createAuthMiddleware is the identity here so the hooks in the captured
// config are the plain async functions auth.ts wrote.
vi.mock("better-auth/api", () => ({
  APIError: class APIError extends Error {
    constructor(
      readonly status: string,
      readonly body: { code?: string; message?: string },
    ) {
      super(body.message);
    }
  },
  createAuthMiddleware: (fn: unknown) => fn,
}));

vi.mock("better-auth/cookies", () => ({
  deleteSessionCookie: vi.fn(),
}));

// The SSO plugin and its Postgres store are exercised end to end in
// sso/sign-in.test.ts; here only their wiring into the config is asserted.
vi.mock("./sso/plugin", () => ({
  SSO_DISABLED_PATHS: ["/sso/register", "/sso/verify-domain"],
  buildSsoPlugin: () => ({ id: "sso" }),
}));
vi.mock("./sso/entitlement", () => ({
  orgHasSso: vi.fn(async () => true),
}));
vi.mock("./sso/pg-store", () => ({
  createPgSsoProvisioningStore: () => ({}),
}));
vi.mock("./sso/policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sso/policy")>()),
  isNonSsoSignInRefused: vi.fn().mockResolvedValue(false),
}));
vi.mock("@oxagen/database/sso-secrets", () => ({
  resolveSsoKms: vi.fn(() => null),
  openSsoConfig: vi.fn(),
}));

vi.mock("better-auth/adapters/drizzle", () => ({
  drizzleAdapter: () => ({ __mock: "drizzle-adapter" }),
}));

// oAuthProxy is only called by buildOAuthProxyPlugins when isLocalEnv=false
// (production-like env). Mock it so re-import tests in non-local env succeed.
vi.mock("better-auth/plugins", () => ({
  oAuthProxy: (opts: unknown) => ({ id: "oauth-proxy", options: opts }),
  twoFactor: (opts: unknown) => ({ id: "two-factor", options: opts }),
}));

vi.mock("@oxagen/database/client", () => ({
  db: () => ({ __mock: "pg-client" }),
}));

vi.mock("@oxagen/database", () => ({
  schema: {
    users: { id: "u.id", emailVerified: "u.emailVerified" },
    sessions: { id: "s.id" },
    accounts: {
      id: "a.id",
      userId: "a.userId",
      providerId: "a.providerId",
      password: "a.password",
      updatedAt: "a.updatedAt",
    },
    verifications: { id: "v.id" },
    rateLimitTable: { id: "r.id" },
    orgUsers: {
      orgId: "ou.orgId",
      userId: "ou.userId",
      joinedAt: "ou.joinedAt",
    },
  },
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: vi.fn(),
}));

// requireEnv reads from process.env so vi.stubEnv controls the values seen
// by module-level code in auth.ts.
vi.mock("@oxagen/config/env", () => ({
  requireEnv: (keys: readonly string[]) => {
    const result: Record<string, string> = {};
    for (const k of keys as string[]) {
      // BETTER_AUTH_URL feeds new URL() in the mail hooks, so its fallback
      // must parse as a URL.
      result[k] =
        process.env[k] ??
        (k === "BETTER_AUTH_URL"
          ? TEST_BETTER_AUTH_URL
          : `test-value-for-${k}`);
    }
    return result;
  },
}));

vi.mock("@oxagen/crypto/kms", () => ({
  createLocalKmsAdapter: vi.fn(() => ({ __mock: "kms-adapter" })),
  loadMasterKey: vi.fn((key: string) => Buffer.from(key)),
}));

// token-encryption.ts imports from @oxagen/crypto
vi.mock("@oxagen/crypto", () => ({
  encrypt: vi.fn().mockResolvedValue(Buffer.from("encrypted")),
  decrypt: vi.fn().mockResolvedValue(Buffer.from("decrypted")),
}));

vi.mock("@oxagen/notifications", () => ({
  sendEmailFireAndForget: vi.fn(),
  resetPasswordEmailTemplate: vi.fn(() => ({
    subject: "Reset your password",
    html: "<p>Click to reset</p>",
  })),
  emailVerificationTemplate: vi.fn(() => ({
    subject: "Verify your email",
    html: "<p>Click to verify</p>",
  })),
  existingAccountEmailTemplate: vi.fn(
    (input: { loginUrl: string; forgotPasswordUrl: string }) => ({
      subject: "You already have an Oxagen account",
      html: `<a href="${input.loginUrl}">Log in</a> <a href="${input.forgotPasswordUrl}">Reset it here</a>`,
    }),
  ),
}));

// account-linking.ts imports from drizzle-orm
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNotNull: (a: unknown) => ({ op: "isNotNull", a }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  inArray: (a: unknown, b: unknown) => ({ op: "inArray", a, b }),
}));

// ---------------------------------------------------------------------------
// Static import — fires auth.ts module-level execution.
// After this resolves, mockCapturedConfig holds the betterAuth config object
// and every module-level statement in auth.ts is covered.
// ---------------------------------------------------------------------------
import { auth } from "./auth";
import { withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import {
  existingAccountEmailTemplate,
  sendEmailFireAndForget,
} from "@oxagen/notifications";
import { deleteSessionCookie } from "better-auth/cookies";
import { isNonSsoSignInRefused } from "./sso/policy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a chainable Drizzle-like query builder that resolves to `rows`.
 * Supports the chain used in resolveFirstOrgId:
 *   tx.select({}).from(t).where(eq).orderBy(t.col).limit(1)
 */
function makeQueryTx(rows: unknown[]): Record<string, unknown> {
  const tx: Record<string, unknown> = {};
  for (const method of [
    "select",
    "from",
    "where",
    "orderBy",
    "limit",
    "update",
    "set",
    "returning",
  ]) {
    tx[method] = () => tx;
  }
  // Make the builder thenable so `await withSystemDb((tx) => tx.select...limit(1))` works.
  tx["then"] = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(rows).then(onFulfilled, onRejected);
  return tx;
}

function getConfig(): Record<string, unknown> {
  if (!capture.config)
    throw new Error("betterAuth config was not captured — import failed");
  return capture.config;
}

// Typed extractor helpers for callback functions embedded in the betterAuth config.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

function getSessionHook(event: "create" | "delete", phase: "after"): AnyFn {
  const hooks = getConfig()["databaseHooks"] as Record<
    string,
    Record<string, Record<string, AnyFn>>
  >;
  return hooks["session"]![event]![phase]!;
}

function getSendResetPasswordFn(): AnyFn {
  const epw = getConfig()["emailAndPassword"] as Record<string, AnyFn>;
  return epw["sendResetPassword"]!;
}

function getSendVerificationEmailFn(): AnyFn {
  const ev = getConfig()["emailVerification"] as Record<string, AnyFn>;
  return ev["sendVerificationEmail"]!;
}

// ---------------------------------------------------------------------------
// Tests: module import and betterAuth config structure
// ---------------------------------------------------------------------------

describe("auth module — import and betterAuth config", () => {
  it("auth export is defined (betterAuth mock was called)", () => {
    expect(auth).toBeDefined();
    expect(auth).not.toBeNull();
  });

  it("betterAuth config was captured at module-eval time", () => {
    expect(capture.config).not.toBeNull();
    expect(typeof getConfig()).toBe("object");
  });

  it("config has all required top-level sections", () => {
    const c = getConfig();
    for (const key of [
      "database",
      "secret",
      "baseURL",
      "trustedOrigins",
      "plugins",
      "user",
      "emailAndPassword",
      "emailVerification",
      "rateLimit",
      "socialProviders",
      "account",
      "session",
      "advanced",
      "databaseHooks",
    ]) {
      expect(c, `missing key: ${key}`).toHaveProperty(key);
    }
  });

  it("trustedOrigins is a non-empty array containing the prod domain", () => {
    const origins = getConfig()["trustedOrigins"] as string[];
    expect(Array.isArray(origins)).toBe(true);
    expect(origins.length).toBeGreaterThan(0);
    expect(origins).toContain("https://app.oxagen.sh");
  });

  it("trustedOrigins includes localhost in test env (NODE_ENV !== production)", () => {
    // NODE_ENV=test in vitest → isLocalEnv=true → DEV_ORIGINS included
    const origins = getConfig()["trustedOrigins"] as string[];
    expect(origins).toContain("http://localhost:3000");
  });

  it("emailAndPassword has correct security policy values", () => {
    const epw = getConfig()["emailAndPassword"] as Record<string, unknown>;
    expect(epw["enabled"]).toBe(true);
    expect(epw["autoSignIn"]).toBe(true);
    expect(epw["minPasswordLength"]).toBe(8);
    expect(epw["revokeSessionsOnPasswordReset"]).toBe(true);
    // In test env (isLocalEnv=true), email verification is not required
    expect(epw["requireEmailVerification"]).toBe(false);
  });

  it("emailVerification.sendOnSignIn is true", () => {
    const ev = getConfig()["emailVerification"] as Record<string, unknown>;
    expect(ev["sendOnSignIn"]).toBe(true);
  });

  it("rateLimit uses database storage with correct SOC2 thresholds", () => {
    const rl = getConfig()["rateLimit"] as Record<string, unknown>;
    expect(rl["storage"]).toBe("database");
    expect(rl["enabled"]).toBe(true); // E2E_TEST not set → rate limiting active
    expect(rl["window"]).toBe(60);
    expect(rl["max"]).toBe(100);
    const rules = rl["customRules"] as Record<string, Record<string, number>>;
    expect(rules["/sign-in/email"]!["max"]).toBe(5);
    expect(rules["/sign-up/email"]!["max"]).toBe(10);
  });

  it("session expiresIn=30d, updateAge=1d", () => {
    const s = getConfig()["session"] as Record<string, number>;
    expect(s["expiresIn"]).toBe(60 * 60 * 24 * 30);
    expect(s["updateAge"]).toBe(60 * 60 * 24);
  });

  it("advanced config: cookiePrefix, httpOnly, sameSite, useSecureCookies", () => {
    const adv = getConfig()["advanced"] as Record<string, unknown>;
    expect(adv["cookiePrefix"]).toBe("oxagen");
    const attrs = adv["defaultCookieAttributes"] as Record<string, unknown>;
    expect(attrs["httpOnly"]).toBe(true);
    expect(attrs["sameSite"]).toBe("lax");
    // In test env (NODE_ENV=test ≠ production) → useSecureCookies = false
    expect(adv["useSecureCookies"]).toBe(false);
  });

  it("advanced.database.generateId produces a valid UUID", () => {
    const adv = getConfig()["advanced"] as Record<string, unknown>;
    const dbOpts = adv["database"] as Record<string, () => string>;
    const uuid = dbOpts["generateId"]!();
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("account.accountLinking: enabled, trusts google+github, no local verified required", () => {
    const acct = getConfig()["account"] as Record<
      string,
      Record<string, unknown>
    >;
    const linking = acct["accountLinking"]!;
    expect(linking["enabled"]).toBe(true);
    expect(linking["trustedProviders"]).toEqual(["google", "github"]);
    expect(linking["requireLocalEmailVerified"]).toBe(false);
  });

  it("user field mapping: name→displayName, image→avatarUrl", () => {
    const user = getConfig()["user"] as Record<string, Record<string, string>>;
    expect(user["fields"]!["name"]).toBe("displayName");
    expect(user["fields"]!["image"]).toBe("avatarUrl");
  });

  it("socialProviders are configured when credentials are present (mock returns fallback values)", () => {
    // requireEnv mock returns "test-value-for-GOOGLE_LOGIN_CLIENT_ID" (truthy)
    const providers = getConfig()["socialProviders"] as Record<string, unknown>;
    expect(providers["google"]).toBeDefined();
    expect(providers["github"]).toBeDefined();
  });

  it("databaseHooks has account, session.create.after and session.delete.after", () => {
    const hooks = getConfig()["databaseHooks"] as Record<string, unknown>;
    expect(hooks).toHaveProperty("account");
    const session = hooks["session"] as Record<string, Record<string, unknown>>;
    expect(typeof session["create"]!["after"]).toBe("function");
    expect(typeof session["delete"]!["after"]).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Enterprise SSO wiring (ADR-145)
// ---------------------------------------------------------------------------

describe("enterprise SSO wiring", () => {
  it("registers the SSO plugin and disables its provider-management paths", () => {
    const plugins = getConfig()["plugins"] as { id: string }[];
    expect(plugins.map((p) => p.id)).toContain("sso");
    expect(getConfig()["disabledPaths"]).toEqual([
      "/sso/register",
      "/sso/verify-domain",
    ]);
  });

  it("rate-limits /sign-in/sso like a password attempt", () => {
    const rl = getConfig()["rateLimit"] as Record<string, unknown>;
    const rules = rl["customRules"] as Record<string, Record<string, number>>;
    expect(rules["/sign-in/sso"]).toEqual({ window: 60, max: 5 });
  });

  it("declares sessions.authMethod as server-written only", () => {
    const s = getConfig()["session"] as Record<string, unknown>;
    const fields = s["additionalFields"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(fields["authMethod"]).toMatchObject({
      type: "string",
      input: false,
    });
  });

  it("session.create.before records how the session was established", async () => {
    const hooks = getConfig()["databaseHooks"] as Record<
      string,
      Record<string, Record<string, AnyFn>>
    >;
    const before = hooks["session"]!["create"]!["before"]!;
    const sso = await before(
      { userId: "u1" },
      { path: "/sso/callback/:providerId", params: { providerId: "acme" } },
    );
    expect(sso.data.authMethod).toBe("sso:acme");
    const pw = await before({ userId: "u1" }, { path: "/sign-in/email" });
    expect(pw.data.authMethod).toBe("password");
    const none = await before({ userId: "u1" }, null);
    expect(none.data.authMethod).toBe("other");
  });

  // The require-SSO hooks live in a plugin so the middleware types stay out
  // of the exported `auth` type (TS2883); find it among the plugins.
  const hooks = () => {
    const plugin = (
      getConfig()["plugins"] as {
        id: string;
        hooks?: {
          before: { matcher: AnyFn; handler: AnyFn }[];
          after: { matcher: AnyFn; handler: AnyFn }[];
        };
      }[]
    ).find((p) => p.id === "oxagen-require-sso");
    const h = plugin!.hooks!;
    return {
      before: h.before[0]!.handler,
      beforeMatches: h.before[0]!.matcher,
      after: h.after[0]!.handler,
      afterMatches: h.after[0]!.matcher,
    };
  };

  it("refuses a password sign-in when the domain requires SSO", async () => {
    vi.mocked(isNonSsoSignInRefused).mockResolvedValueOnce(true);
    await expect(
      hooks().before({ path: "/sign-in/email", body: { email: "a@acme.com" } }),
    ).rejects.toMatchObject({ body: { code: "SSO_REQUIRED" } });
  });

  it("lets a password sign-in through when the domain does not require SSO", async () => {
    vi.mocked(isNonSsoSignInRefused).mockResolvedValueOnce(false);
    await expect(
      hooks().before({ path: "/sign-in/email", body: { email: "a@b.com" } }),
    ).resolves.toBeUndefined();
  });

  it("runs only on the password sign-in and the social callback", () => {
    expect(hooks().beforeMatches({ path: "/sign-in/email" })).toBe(true);
    expect(hooks().beforeMatches({ path: "/sign-in/sso" })).toBe(false);
    expect(hooks().afterMatches({ path: "/callback/google" })).toBe(true);
    expect(hooks().afterMatches({ path: "/sso/callback/acme" })).toBe(false);
  });

  it("ends a social sign-in into an SSO-required domain and redirects to /login", async () => {
    vi.mocked(isNonSsoSignInRefused).mockResolvedValueOnce(true);
    const deleteSession = vi.fn();
    const redirect = vi.fn((url: string) => new Error(`redirect:${url}`));
    await expect(
      hooks().after({
        path: "/callback/google",
        redirect,
        context: {
          newSession: {
            user: { email: "a@acme.com" },
            session: { token: "t" },
          },
          internalAdapter: { deleteSession },
        },
      }),
    ).rejects.toThrow("redirect:/login?sso=required");
    expect(deleteSession).toHaveBeenCalledWith("t");
    expect(deleteSessionCookie).toHaveBeenCalled();
  });

  it("leaves a social sign-in alone when the domain does not require SSO", async () => {
    vi.mocked(isNonSsoSignInRefused).mockResolvedValueOnce(false);
    const deleteSession = vi.fn();
    await hooks().after({
      path: "/callback/google",
      redirect: vi.fn(),
      context: {
        newSession: { user: { email: "a@b.com" }, session: { token: "t" } },
        internalAdapter: { deleteSession },
      },
    });
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sendResetPassword callback body
// ---------------------------------------------------------------------------

describe("emailAndPassword.sendResetPassword callback", () => {
  beforeEach(() => {
    vi.mocked(sendEmailFireAndForget).mockClear();
  });

  it("calls sendEmailFireAndForget with the reset tag and user email", async () => {
    const fn = getSendResetPasswordFn();
    await fn({
      user: { email: "reset@example.com" },
      url: "https://app.oxagen.sh/reset?token=abc",
    });

    expect(sendEmailFireAndForget).toHaveBeenCalledOnce();
    const [emailArg, tagArg] = vi.mocked(sendEmailFireAndForget).mock
      .calls[0]! as [Record<string, unknown>, string];
    expect(emailArg["to"]).toBe("reset@example.com");
    expect(tagArg).toBe("password-reset");
  });

  it("fire-and-forget — resolves to undefined without throwing", async () => {
    const fn = getSendResetPasswordFn();
    await expect(
      fn({
        user: { email: "fire@example.com" },
        url: "https://example.com/reset?t=x",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onExistingUserSignUp callback body (#4043)
// ---------------------------------------------------------------------------

describe("emailAndPassword.onExistingUserSignUp callback", () => {
  beforeEach(() => {
    vi.mocked(sendEmailFireAndForget).mockClear();
    vi.mocked(existingAccountEmailTemplate).mockClear();
  });

  it("is configured, so a sign-up with a registered address mails the owner", () => {
    const epw = getConfig()["emailAndPassword"] as Record<string, unknown>;
    expect(typeof epw["onExistingUserSignUp"]).toBe("function");
  });

  it("sends one mail to the owner with the login and forgot-password links", async () => {
    const epw = getConfig()["emailAndPassword"] as Record<string, AnyFn>;
    await expect(
      epw["onExistingUserSignUp"]!({ user: { email: "owner@example.com" } }),
    ).resolves.toBeUndefined();

    expect(sendEmailFireAndForget).toHaveBeenCalledOnce();
    const [emailArg, tagArg] = vi.mocked(sendEmailFireAndForget).mock
      .calls[0]! as [Record<string, unknown>, string];
    expect(emailArg["to"]).toBe("owner@example.com");
    expect(tagArg).toBe("existing-account");

    const templateInput = vi.mocked(existingAccountEmailTemplate).mock
      .calls[0]![0];
    const base = process.env.BETTER_AUTH_URL ?? TEST_BETTER_AUTH_URL;
    expect(templateInput.email).toBe("owner@example.com");
    expect(templateInput.loginUrl).toBe(new URL("/login", base).toString());
    expect(templateInput.forgotPasswordUrl).toBe(
      new URL("/forgot-password", base).toString(),
    );
    expect(emailArg["html"]).toContain("Log in");
    expect(emailArg["html"]).toContain("Reset it here");
  });
});

// ---------------------------------------------------------------------------
// sendVerificationEmail callback body
// ---------------------------------------------------------------------------

describe("emailVerification.sendVerificationEmail callback", () => {
  beforeEach(() => {
    vi.mocked(sendEmailFireAndForget).mockClear();
  });

  it("calls sendEmailFireAndForget with the verification tag and user email", async () => {
    const fn = getSendVerificationEmailFn();
    await fn({
      user: { email: "verify@example.com" },
      url: "https://app.oxagen.sh/verify?token=tok",
    });

    expect(sendEmailFireAndForget).toHaveBeenCalledOnce();
    const [emailArg, tagArg] = vi.mocked(sendEmailFireAndForget).mock
      .calls[0]! as [Record<string, unknown>, string];
    expect(emailArg["to"]).toBe("verify@example.com");
    expect(tagArg).toBe("verification");
  });

  it("fire-and-forget — resolves to undefined without throwing", async () => {
    const fn = getSendVerificationEmailFn();
    await expect(
      fn({
        user: { email: "v@example.com" },
        url: "https://example.com/verify?t=y",
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// databaseHooks.session.create.after — covers resolveFirstOrgId body
// ---------------------------------------------------------------------------

describe("databaseHooks.session.create.after (sign_in audit)", () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockClear();
    vi.mocked(emitSecurityEvent).mockClear();
  });

  it("emits auth.sign_in event with the resolved orgId on the happy path", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn(makeQueryTx([{ orgId: "org_happy" }])),
    );

    const hook = getSessionHook("create", "after");
    await hook({
      userId: "user_1",
      ipAddress: "1.2.3.4",
      userAgent: "TestBrowser/1",
    });

    expect(emitSecurityEvent).toHaveBeenCalledOnce();
    const [event] = vi.mocked(emitSecurityEvent).mock.calls[0]! as unknown as [
      Record<string, unknown>,
    ];
    expect(event["eventType"]).toBe("auth.sign_in");
    expect(event["actorUserId"]).toBe("user_1");
    expect(event["orgId"]).toBe("org_happy");
    expect(event["outcome"]).toBe("success");
  });

  it("uses NO_ORG_SENTINEL (nil UUID) when user has no org membership", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(makeQueryTx([])), // empty rows → no org
    );

    const hook = getSessionHook("create", "after");
    await hook({ userId: "user_new" });

    expect(emitSecurityEvent).toHaveBeenCalledOnce();
    const [event] = vi.mocked(emitSecurityEvent).mock.calls[0]! as unknown as [
      Record<string, unknown>,
    ];
    expect(event["orgId"]).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("SECURITY: DB failure in resolveFirstOrgId is swallowed — hook resolves", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockRejectedValue(new Error("connection refused"));

    const hook = getSessionHook("create", "after");
    // Must RESOLVE not REJECT — a rejection turns a committed sign-in into an HTTP 500.
    await expect(hook({ userId: "user_2" })).resolves.toBeUndefined();
    // No audit event because resolve failed before emitSecurityEvent ran.
    expect(emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("populates ip and userAgent from session fields in the audit event", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn(makeQueryTx([{ orgId: "org_ip" }])),
    );

    const hook = getSessionHook("create", "after");
    await hook({
      userId: "user_3",
      ipAddress: "203.0.113.5",
      userAgent: "curl/7.88",
    });

    const [event] = vi.mocked(emitSecurityEvent).mock.calls[0]! as unknown as [
      Record<string, unknown>,
    ];
    expect(event["ip"]).toBe("203.0.113.5");
    expect(event["userAgent"]).toBe("curl/7.88");
  });

  it("passes null for ip and userAgent when absent from session", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn(makeQueryTx([{ orgId: "org_null" }])),
    );

    const hook = getSessionHook("create", "after");
    await hook({ userId: "user_4" }); // no ip/userAgent fields

    const [event] = vi.mocked(emitSecurityEvent).mock.calls[0]! as unknown as [
      Record<string, unknown>,
    ];
    expect(event["ip"]).toBeNull();
    expect(event["userAgent"]).toBeNull();
  });

  it("SECURITY: emitSecurityEvent failure is also swallowed — sign-in succeeds", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn(makeQueryTx([{ orgId: "org_5" }])),
    );
    vi.mocked(emitSecurityEvent).mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });

    const hook = getSessionHook("create", "after");
    await expect(hook({ userId: "user_5" })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// databaseHooks.session.delete.after — sign_out audit
// ---------------------------------------------------------------------------

describe("databaseHooks.session.delete.after (sign_out audit)", () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockClear();
    vi.mocked(emitSecurityEvent).mockClear();
  });

  it("emits auth.sign_out event with the resolved orgId on the happy path", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn(makeQueryTx([{ orgId: "org_signout" }])),
    );

    const hook = getSessionHook("delete", "after");
    await hook({
      userId: "user_del_1",
      ipAddress: "10.0.0.9",
      userAgent: "Agent/2",
    });

    expect(emitSecurityEvent).toHaveBeenCalledOnce();
    const [event] = vi.mocked(emitSecurityEvent).mock.calls[0]! as unknown as [
      Record<string, unknown>,
    ];
    expect(event["eventType"]).toBe("auth.sign_out");
    expect(event["actorUserId"]).toBe("user_del_1");
    expect(event["orgId"]).toBe("org_signout");
    expect(event["outcome"]).toBe("success");
  });

  it("uses NO_ORG_SENTINEL on sign-out when user has no org", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(makeQueryTx([])),
    );

    const hook = getSessionHook("delete", "after");
    await hook({ userId: "user_del_2" });

    const [event] = vi.mocked(emitSecurityEvent).mock.calls[0]! as unknown as [
      Record<string, unknown>,
    ];
    expect(event["orgId"]).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("SECURITY: DB failure on sign-out is swallowed — hook resolves", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockRejectedValue(new Error("pg gone"));

    const hook = getSessionHook("delete", "after");
    await expect(hook({ userId: "user_del_3" })).resolves.toBeUndefined();
    expect(emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("SECURITY: emitSecurityEvent failure on sign-out is swallowed", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (withSystemDb as any).mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn(makeQueryTx([{ orgId: "org_d" }])),
    );
    vi.mocked(emitSecurityEvent).mockImplementation(() => {
      throw new Error("clickhouse down");
    });

    const hook = getSessionHook("delete", "after");
    await expect(hook({ userId: "user_del_4" })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Startup guard — re-import branches (requires vi.resetModules)
// ---------------------------------------------------------------------------

describe("startup guard — production env without encryption key", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws AUTH_TOKEN_ENCRYPTION_KEY error in non-local env without the key", async () => {
    vi.resetModules();
    // Simulate production deployment: NODE_ENV=production + Vercel signals
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AUTH_TOKEN_ENCRYPTION_KEY", ""); // empty = falsy

    await expect(import("./auth")).rejects.toThrow(
      "AUTH_TOKEN_ENCRYPTION_KEY is required in non-local environments",
    );
  });

  it("does NOT throw during the Next.js build phase (NEXT_PHASE=phase-production-build)", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AUTH_TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");

    // Build phase skips the guard — module must resolve cleanly
    const mod = await import("./auth");
    expect(mod).toBeDefined();
  });

  it("does NOT throw when E2E_TEST=true (Playwright CI bypass)", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    // NOT setting VERCEL so isLocalEnv check uses E2E_TEST path
    vi.stubEnv("AUTH_TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("E2E_TEST", "true");

    const mod = await import("./auth");
    expect(mod).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// kmsAdapter creation — re-import with AUTH_TOKEN_ENCRYPTION_KEY set
// ---------------------------------------------------------------------------

describe("kmsAdapter — created when AUTH_TOKEN_ENCRYPTION_KEY is present", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("calls createLocalKmsAdapter and loadMasterKey when the key is set", async () => {
    vi.resetModules();
    const testKey = "dGVzdC1rZXktdmFsdWU="; // any non-empty string
    vi.stubEnv("AUTH_TOKEN_ENCRYPTION_KEY", testKey);
    // Keep NODE_ENV=test (default) so isLocalEnv=true and the guard does not throw

    await import("./auth"); // module re-evaluates with key present → kmsAdapter branch

    // @oxagen/crypto/kms is now in the module cache from the re-import above
    const kmsModule = await import("@oxagen/crypto/kms");
    expect(vi.mocked(kmsModule.createLocalKmsAdapter)).toHaveBeenCalledOnce();
    expect(vi.mocked(kmsModule.loadMasterKey)).toHaveBeenCalledWith(testKey);
  });
});

// ---------------------------------------------------------------------------
// Remaining branch coverage — BETTER_AUTH_TRUSTED_ORIGINS (line 147) and
// social provider undefined branches (lines 371, 375)
// ---------------------------------------------------------------------------

describe("BETTER_AUTH_TRUSTED_ORIGINS env var — truthy branch (line 147)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("parses comma-separated origins from BETTER_AUTH_TRUSTED_ORIGINS into trustedOrigins", async () => {
    vi.resetModules();
    vi.stubEnv(
      "BETTER_AUTH_TRUSTED_ORIGINS",
      "https://custom.example.com, https://other.example.com",
    );

    await import("./auth");

    // Verify betterAuth was called with the parsed custom origins included
    expect(capture.config).not.toBeNull();
    const origins = (capture.config as Record<string, unknown>)[
      "trustedOrigins"
    ] as string[];
    expect(origins).toContain("https://custom.example.com");
    expect(origins).toContain("https://other.example.com");
  });
});

describe("socialProviders — undefined branches when credentials are absent (lines 371, 375)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("google and github are undefined when their credentials are empty strings", async () => {
    vi.resetModules();
    // Empty strings are falsy → ternary takes the `undefined` branch for each provider
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_LOGIN_CLIENT_SECRET", "");
    vi.stubEnv("GITHUB_LOGIN_CLIENT_ID", "");
    vi.stubEnv("GITHUB_LOGIN_CLIENT_SECRET", "");

    await import("./auth");

    expect(capture.config).not.toBeNull();
    const providers = (capture.config as Record<string, unknown>)[
      "socialProviders"
    ] as Record<string, unknown>;
    expect(providers["google"]).toBeUndefined();
    expect(providers["github"]).toBeUndefined();
  });
});
