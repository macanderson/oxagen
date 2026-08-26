/**
 * Unit tests for the trusted-provider account-linking hardening
 * (./account-linking.ts).
 *
 * Coverage strategy mirrors the rest of @oxagen/auth: the DB module boundary
 * (@oxagen/database) and drizzle-orm helpers are mocked, and the pure policy
 * functions / orchestration / hook wrapper are exercised with injected fakes so
 * no live Postgres is required. The security-critical invariant under test is:
 * a trusted social provider linked into an UNVERIFIED local account must revoke
 * that account's stale credential password (account pre-hijacking mitigation),
 * while verified accounts and non-trusted/credential writes are left untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by vitest. The chainable `tx` returned by withSystemDb
// is a thenable that pops successive results off a per-test queue, so a single
// builder satisfies select(...).from(...).where(...).limit(1) AND
// update(...).set(...).where(...).returning(...). drizzle helpers are stubbed
// to plain tokens since the mock tx never compiles SQL.
// ---------------------------------------------------------------------------
const withSystemDbMock = vi.fn();

// captureError is the telemetry escalation seam used by the default logger's
// error path; mocked so unit tests never touch the real telemetry pipeline.
const captureErrorMock = vi.fn();

vi.mock("@oxagen/telemetry", () => ({
  captureError: (...args: unknown[]) => captureErrorMock(...args),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) => withSystemDbMock(fn),
  schema: {
    users: { id: "users.id", emailVerified: "users.emailVerified" },
    accounts: {
      id: "accounts.id",
      userId: "accounts.userId",
      providerId: "accounts.providerId",
      password: "accounts.password",
      updatedAt: "accounts.updatedAt",
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNotNull: (a: unknown) => ({ isNotNull: a }),
}));

import { logger as authLogger } from "./logger";
import {
  isTrustedOAuthProvider,
  shouldRevokeLocalCredentialPassword,
  hardenTrustedProviderLink,
  withTrustedLinkHardening,
  createDbAccountLinkingStore,
  TRUSTED_OAUTH_PROVIDERS,
  CREDENTIAL_PROVIDER_ID,
  type AccountLinkingStore,
  type AccountLinkingLogger,
  type AccountDatabaseHooks,
} from "./account-linking";

// A chainable, thenable drizzle-query stub that resolves to queued results.
function makeTx(queue: unknown[]): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  for (const m of [
    "select",
    "from",
    "where",
    "limit",
    "update",
    "set",
    "returning",
  ]) {
    builder[m] = () => builder;
  }
  builder.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(queue.shift()).then(onFulfilled, onRejected);
  return builder;
}

function fakeLogger(): AccountLinkingLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), error: vi.fn() };
}

beforeEach(() => {
  withSystemDbMock.mockReset();
  captureErrorMock.mockReset();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("trusts exactly google and github (both verify their email)", () => {
    expect([...TRUSTED_OAUTH_PROVIDERS]).toEqual(["google", "github"]);
  });

  it("credential provider id matches Better Auth's email/password account", () => {
    expect(CREDENTIAL_PROVIDER_ID).toBe("credential");
  });
});

// ---------------------------------------------------------------------------
// isTrustedOAuthProvider
// ---------------------------------------------------------------------------

describe("isTrustedOAuthProvider", () => {
  it("is true for the default trusted providers", () => {
    expect(isTrustedOAuthProvider("google")).toBe(true);
    expect(isTrustedOAuthProvider("github")).toBe(true);
  });

  it("is false for the credential provider and other social providers", () => {
    expect(isTrustedOAuthProvider("credential")).toBe(false);
    expect(isTrustedOAuthProvider("apple")).toBe(false);
  });

  it("is false for non-string / empty inputs", () => {
    expect(isTrustedOAuthProvider(undefined)).toBe(false);
    expect(isTrustedOAuthProvider(null)).toBe(false);
    expect(isTrustedOAuthProvider(123)).toBe(false);
    expect(isTrustedOAuthProvider("")).toBe(false);
  });

  it("honors a custom trusted list", () => {
    expect(isTrustedOAuthProvider("apple", ["apple"])).toBe(true);
    expect(isTrustedOAuthProvider("google", ["apple"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldRevokeLocalCredentialPassword (pure policy)
// ---------------------------------------------------------------------------

describe("shouldRevokeLocalCredentialPassword", () => {
  it("revokes when a trusted provider links into an unverified account with a password", () => {
    expect(
      shouldRevokeLocalCredentialPassword({
        providerId: "google",
        userEmailVerified: false,
        hasLocalPassword: true,
      }),
    ).toBe(true);
  });

  it("does NOT revoke for an untrusted/credential provider", () => {
    expect(
      shouldRevokeLocalCredentialPassword({
        providerId: "credential",
        userEmailVerified: false,
        hasLocalPassword: true,
      }),
    ).toBe(false);
  });

  it("does NOT revoke when the local email is already verified (password is trusted)", () => {
    expect(
      shouldRevokeLocalCredentialPassword({
        providerId: "google",
        userEmailVerified: true,
        hasLocalPassword: true,
      }),
    ).toBe(false);
  });

  it("does NOT revoke when there is no local password to revoke", () => {
    expect(
      shouldRevokeLocalCredentialPassword({
        providerId: "google",
        userEmailVerified: false,
        hasLocalPassword: false,
      }),
    ).toBe(false);
  });

  it("honors a custom trusted-providers list", () => {
    expect(
      shouldRevokeLocalCredentialPassword({
        providerId: "apple",
        userEmailVerified: false,
        hasLocalPassword: true,
        trustedProviders: ["apple"],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hardenTrustedProviderLink (orchestration with injected store)
// ---------------------------------------------------------------------------

function fakeStore(overrides: Partial<AccountLinkingStore> = {}): {
  store: AccountLinkingStore;
  loadLinkTargetFacts: ReturnType<typeof vi.fn>;
  clearLocalPassword: ReturnType<typeof vi.fn>;
} {
  const loadLinkTargetFacts = vi.fn(
    overrides.loadLinkTargetFacts ?? (async () => null),
  );
  const clearLocalPassword = vi.fn(
    overrides.clearLocalPassword ?? (async () => 0),
  );
  return {
    store: { loadLinkTargetFacts, clearLocalPassword },
    loadLinkTargetFacts,
    clearLocalPassword,
  };
}

describe("hardenTrustedProviderLink", () => {
  it("no-ops (no DB read) for a non-trusted/credential account create", async () => {
    const { store, loadLinkTargetFacts } = fakeStore();
    const log = fakeLogger();
    const result = await hardenTrustedProviderLink(
      { userId: "u1", providerId: "credential" },
      store,
      log,
    );
    expect(result).toBe(false);
    expect(loadLinkTargetFacts).not.toHaveBeenCalled();
  });

  it("no-ops when userId is missing, empty, or not a string", async () => {
    const { store, loadLinkTargetFacts } = fakeStore();
    expect(
      await hardenTrustedProviderLink({ providerId: "google" }, store),
    ).toBe(false);
    expect(
      await hardenTrustedProviderLink(
        { userId: "", providerId: "google" },
        store,
      ),
    ).toBe(false);
    expect(
      await hardenTrustedProviderLink(
        { userId: 42, providerId: "google" },
        store,
      ),
    ).toBe(false);
    expect(loadLinkTargetFacts).not.toHaveBeenCalled();
  });

  it("no-ops for a brand-new OAuth sign-up (no existing user row)", async () => {
    const { store, loadLinkTargetFacts, clearLocalPassword } = fakeStore({
      loadLinkTargetFacts: async () => null,
    });
    const result = await hardenTrustedProviderLink(
      { userId: "u1", providerId: "google" },
      store,
    );
    expect(result).toBe(false);
    expect(loadLinkTargetFacts).toHaveBeenCalledWith("u1");
    expect(clearLocalPassword).not.toHaveBeenCalled();
  });

  it("does NOT revoke when the existing account's email is already verified", async () => {
    const { store, clearLocalPassword } = fakeStore({
      loadLinkTargetFacts: async () => ({
        userEmailVerified: true,
        hasLocalPassword: true,
      }),
    });
    expect(
      await hardenTrustedProviderLink(
        { userId: "u1", providerId: "google" },
        store,
      ),
    ).toBe(false);
    expect(clearLocalPassword).not.toHaveBeenCalled();
  });

  it("does NOT revoke when the unverified account has no password", async () => {
    const { store, clearLocalPassword } = fakeStore({
      loadLinkTargetFacts: async () => ({
        userEmailVerified: false,
        hasLocalPassword: false,
      }),
    });
    expect(
      await hardenTrustedProviderLink(
        { userId: "u1", providerId: "google" },
        store,
      ),
    ).toBe(false);
    expect(clearLocalPassword).not.toHaveBeenCalled();
  });

  it("REVOKES and logs when a trusted provider links into an unverified account with a password", async () => {
    const { store, clearLocalPassword } = fakeStore({
      loadLinkTargetFacts: async () => ({
        userEmailVerified: false,
        hasLocalPassword: true,
      }),
      clearLocalPassword: async () => 1,
    });
    const log = fakeLogger();
    const result = await hardenTrustedProviderLink(
      { userId: "u1", providerId: "github" },
      store,
      log,
    );
    expect(result).toBe(true);
    expect(clearLocalPassword).toHaveBeenCalledWith("u1");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("revoked stale credential password"),
      { userId: "u1", providerId: "github", revoked: 1 },
    );
  });

  it("does NOT log a revocation when the password was already gone (race → 0 rows)", async () => {
    const { store } = fakeStore({
      loadLinkTargetFacts: async () => ({
        userEmailVerified: false,
        hasLocalPassword: true,
      }),
      clearLocalPassword: async () => 0,
    });
    const log = fakeLogger();
    expect(
      await hardenTrustedProviderLink(
        { userId: "u1", providerId: "google" },
        store,
        log,
      ),
    ).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("uses the default structured logger when none is injected", async () => {
    const warnSpy = vi.spyOn(authLogger, "warn").mockImplementation(() => undefined);
    const { store } = fakeStore({
      loadLinkTargetFacts: async () => ({
        userEmailVerified: false,
        hasLocalPassword: true,
      }),
      clearLocalPassword: async () => 1,
    });
    await hardenTrustedProviderLink(
      { userId: "u1", providerId: "google" },
      store,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // pino signature: (context, message) — the revocation context must carry
    // the identifying fields without ever including the password itself.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        providerId: "google",
        revoked: 1,
      }),
      expect.stringContaining("revoked stale credential password"),
    );
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// withTrustedLinkHardening (databaseHooks composition)
// ---------------------------------------------------------------------------

function fakeBaseHooks(): AccountDatabaseHooks & {
  createBefore: ReturnType<typeof vi.fn>;
  updateBefore: ReturnType<typeof vi.fn>;
} {
  // Base create.before mimics the token strip: drops `accessToken`.
  const createBefore = vi.fn(async (account: Record<string, unknown>) => {
    const { accessToken: _at, ...rest } = account;
    void _at;
    return { data: rest };
  });
  const updateBefore = vi.fn(async (account: Record<string, unknown>) => ({
    data: account,
  }));
  return {
    create: { before: createBefore },
    update: { before: updateBefore },
    createBefore,
    updateBefore,
  };
}

describe("withTrustedLinkHardening", () => {
  it("passes the update hook through unchanged (identity reference)", () => {
    const base = fakeBaseHooks();
    const { store } = fakeStore();
    const wrapped = withTrustedLinkHardening(base, store);
    expect(wrapped.update).toBe(base.update);
  });

  it("runs the base create.before transform and returns its data", async () => {
    const base = fakeBaseHooks();
    const { store } = fakeStore();
    const wrapped = withTrustedLinkHardening(base, store);
    const out = await wrapped.create.before({
      userId: "u1",
      providerId: "google",
      accessToken: "secret",
    });
    // Token stripped by the base hook, preserved through the wrapper.
    expect(out).toEqual({ data: { userId: "u1", providerId: "google" } });
    expect(base.createBefore).toHaveBeenCalledTimes(1);
  });

  it("invokes the hardening side effect on a trusted-provider create", async () => {
    const base = fakeBaseHooks();
    const { store, clearLocalPassword } = fakeStore({
      loadLinkTargetFacts: async () => ({
        userEmailVerified: false,
        hasLocalPassword: true,
      }),
      clearLocalPassword: async () => 1,
    });
    const wrapped = withTrustedLinkHardening(base, store, fakeLogger());
    await wrapped.create.before({ userId: "u1", providerId: "google" });
    expect(clearLocalPassword).toHaveBeenCalledWith("u1");
  });

  it("does NOT touch credentials on a non-trusted (credential) create", async () => {
    const base = fakeBaseHooks();
    const { store, loadLinkTargetFacts } = fakeStore();
    const wrapped = withTrustedLinkHardening(base, store);
    await wrapped.create.before({ userId: "u1", providerId: "credential" });
    expect(loadLinkTargetFacts).not.toHaveBeenCalled();
  });

  it("SECURITY: swallows a hardening failure so OAuth sign-in still succeeds", async () => {
    const base = fakeBaseHooks();
    const store: AccountLinkingStore = {
      loadLinkTargetFacts: async () => {
        throw new Error("db down");
      },
      clearLocalPassword: async () => 0,
    };
    const log = fakeLogger();
    const wrapped = withTrustedLinkHardening(base, store, log);
    // Must resolve (not reject) and still return the base transform result.
    const out = await wrapped.create.before({
      userId: "u1",
      providerId: "google",
      accessToken: "x",
    });
    expect(out).toEqual({ data: { userId: "u1", providerId: "google" } });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("password-revocation hook failed"),
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it("logs hardening failures via the default structured logger when none injected", async () => {
    const errorSpy = vi.spyOn(authLogger, "error").mockImplementation(() => undefined);
    const base = fakeBaseHooks();
    const store: AccountLinkingStore = {
      loadLinkTargetFacts: async () => {
        throw new Error("db down");
      },
      clearLocalPassword: async () => 0,
    };
    const wrapped = withTrustedLinkHardening(base, store);
    await wrapped.create.before({ userId: "u1", providerId: "google" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // The default error path also escalates through captureError so a spike in
    // failed pre-hijacking mitigations is alertable, not just greppable.
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        source: "app",
        severity: "warn",
      }),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// createDbAccountLinkingStore (DB-backed, withSystemDb + drizzle mocked)
// ---------------------------------------------------------------------------

describe("createDbAccountLinkingStore", () => {
  it("loadLinkTargetFacts returns null when the user row is absent", async () => {
    withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTx([[]])),
    );
    const store = createDbAccountLinkingStore();
    expect(await store.loadLinkTargetFacts("missing")).toBeNull();
  });

  it("loadLinkTargetFacts reports hasLocalPassword=true when a credential row with a password exists", async () => {
    // queue: users query → one row (unverified); credentials query → one row.
    withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTx([[{ emailVerified: false }], [{ id: "acc1" }]])),
    );
    const store = createDbAccountLinkingStore();
    expect(await store.loadLinkTargetFacts("u1")).toEqual({
      userEmailVerified: false,
      hasLocalPassword: true,
    });
  });

  it("loadLinkTargetFacts reports hasLocalPassword=false when no credential password exists", async () => {
    withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTx([[{ emailVerified: true }], []])),
    );
    const store = createDbAccountLinkingStore();
    expect(await store.loadLinkTargetFacts("u1")).toEqual({
      userEmailVerified: true,
      hasLocalPassword: false,
    });
  });

  it("clearLocalPassword returns the number of revoked rows", async () => {
    withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTx([[{ id: "acc1" }]])),
    );
    const store = createDbAccountLinkingStore();
    expect(await store.clearLocalPassword("u1")).toBe(1);
  });

  it("clearLocalPassword returns 0 when no credential row carried a password", async () => {
    withSystemDbMock.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(makeTx([[]])),
    );
    const store = createDbAccountLinkingStore();
    expect(await store.clearLocalPassword("u1")).toBe(0);
  });
});
