/**
 * plugin.oauth-refresh-watcher tests.
 *
 * The database, drizzle operators, MCP SDK auth(), and the plugins package
 * are mocked. drizzle's operators return plain tuples, so a test can read the
 * selection query's where clause back and check each filter.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  mcpAuth: vi.fn(),
  markCredentialNeedsReauth: vi.fn(),
  providerCtor: vi.fn(),
  inngestCreateFunction: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  guardedFetch: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ["and", ...parts],
  eq: (a: unknown, b: unknown) => ["eq", a, b],
  lt: (a: unknown, b: unknown) => ["lt", a, b],
  isNull: (a: unknown) => ["isNull", a],
  isNotNull: (a: unknown) => ["isNotNull", a],
  sql: Object.assign(() => ["sql"], {
    raw: (text: string) => ["raw", text],
  }),
}));

vi.mock("@oxagen/database", () => ({
  withSystemDb: mocks.withSystemDb,
  schema: {
    mcpCredentials: {
      id: "cred.id",
      workspaceId: "cred.workspaceId",
      orgListingId: "cred.orgListingId",
      orgId: "cred.orgId",
      authKind: "cred.authKind",
      status: "cred.status",
      expiresAt: "cred.expiresAt",
      refreshTokenEnc: "cred.refreshTokenEnc",
    },
    pluginInstalledPlugins: {
      id: "plugin.id",
      endpointUrl: "plugin.endpointUrl",
      deletedAt: "plugin.deletedAt",
      enabled: "plugin.enabled",
    },
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mocks.mcpAuth,
}));

vi.mock("@oxagen/agent/runtime/mcp-oauth-fetch", () => ({
  mcpOAuthFetch: mocks.guardedFetch,
}));

vi.mock("@oxagen/plugins", () => ({
  DbOAuthClientProvider: class {
    constructor(ctx: unknown) {
      mocks.providerCtor(ctx);
    }
  },
  markCredentialNeedsReauth: mocks.markCredentialNeedsReauth,
}));

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.inngestCreateFunction,
}));

type Handler = (ctx: {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

let capturedHandler: Handler | null = null;
let capturedTrigger: unknown = null;

mocks.inngestCreateFunction.mockImplementation(
  (_opts: unknown, trigger: unknown, handler: Handler) => {
    capturedTrigger = trigger;
    capturedHandler = handler;
    return [{}];
  },
);

const watcher = await import("./plugin.oauth-refresh-watcher");

/** Each query resolves to the next queued result. Where clauses are recorded. */
function installDb(results: unknown[][]) {
  const whereClauses: unknown[] = [];
  const queue = [...results];
  const tx = {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: (clause: unknown) => {
          whereClauses.push(clause);
          return Promise.resolve(queue.shift() ?? []);
        },
      };
      return chain;
    },
  };
  mocks.withSystemDb.mockImplementation(
    async (fn: (t: typeof tx) => unknown) => fn(tx),
  );
  return whereClauses;
}

// step.run output is JSON, so the Date comes back as a string.
const EXPIRES = "2026-09-30T12:20:00.000Z";

const credential = {
  id: "cred-1",
  workspaceId: "ws-1",
  orgListingId: "listing-1",
  orgId: "org-1",
  expiresAt: EXPIRES,
  endpointUrl: "https://mcp.example.com/mcp",
};

async function run() {
  return capturedHandler!({
    step: {
      run: async (_name, fn) => JSON.parse(JSON.stringify(await fn())),
    },
  });
}

beforeEach(() => {
  mocks.withSystemDb.mockReset();
  mocks.mcpAuth.mockReset();
  mocks.markCredentialNeedsReauth.mockReset().mockResolvedValue(undefined);
  mocks.providerCtor.mockReset();
  mocks.loggerInfo.mockReset();
  mocks.loggerWarn.mockReset();
});

describe("refresh window", () => {
  it("covers one schedule interval plus a margin", () => {
    expect(watcher.REFRESH_WINDOW_MINUTES).toBe(
      watcher.REFRESH_INTERVAL_MINUTES + watcher.REFRESH_MARGIN_MINUTES,
    );
    expect(watcher.REFRESH_WINDOW_MINUTES).toBeGreaterThan(
      watcher.REFRESH_INTERVAL_MINUTES,
    );
  });

  it("builds the cron schedule from the interval", () => {
    expect(capturedTrigger).toEqual({
      cron: `*/${watcher.REFRESH_INTERVAL_MINUTES} * * * *`,
    });
  });
});

describe("selection query", () => {
  it("filters on refresh token, window, and a live enabled provider", async () => {
    const where = installDb([[]]);
    await run();

    const clause = where[0] as unknown[];
    expect(clause[0]).toBe("and");
    const parts = clause.slice(1);
    expect(parts).toContainEqual(["eq", "cred.authKind", "oauth"]);
    expect(parts).toContainEqual(["eq", "cred.status", "active"]);
    expect(parts).toContainEqual(["isNotNull", "cred.refreshTokenEnc"]);
    expect(parts).toContainEqual([
      "lt",
      "cred.expiresAt",
      ["raw", `now() + interval '${watcher.REFRESH_WINDOW_MINUTES} minutes'`],
    ]);
    expect(parts).toContainEqual(["isNull", "plugin.deletedAt"]);
    expect(parts).toContainEqual(["eq", "plugin.enabled", true]);
  });
});

describe("refresh outcome", () => {
  it("counts AUTHORIZED as refreshed and passes the guarded fetch", async () => {
    installDb([[credential]]);
    mocks.mcpAuth.mockResolvedValue("AUTHORIZED");

    const result = await run();

    expect(mocks.mcpAuth).toHaveBeenCalledWith(expect.anything(), {
      serverUrl: credential.endpointUrl,
      fetchFn: mocks.guardedFetch,
    });
    expect(mocks.markCredentialNeedsReauth).not.toHaveBeenCalled();
    expect(result).toEqual({
      total: 1,
      refreshed: 1,
      markedReauth: 0,
      handledElsewhere: 0,
    });
  });

  it("marks needs_reauth and counts a failure when auth() returns REDIRECT", async () => {
    installDb([
      [credential],
      [{ status: "active", expiresAt: new Date(EXPIRES) }],
    ]);
    mocks.mcpAuth.mockResolvedValue("REDIRECT");

    const result = await run();

    expect(mocks.markCredentialNeedsReauth).toHaveBeenCalledWith(
      "ws-1",
      "listing-1",
    );
    expect(result).toEqual({
      total: 1,
      refreshed: 0,
      markedReauth: 1,
      handledElsewhere: 0,
    });
  });

  it("marks needs_reauth when auth() throws", async () => {
    installDb([
      [credential],
      [{ status: "active", expiresAt: new Date(EXPIRES) }],
    ]);
    mocks.mcpAuth.mockRejectedValue(new Error("invalid_grant"));

    const result = await run();

    expect(mocks.markCredentialNeedsReauth).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ refreshed: 0, markedReauth: 1 });
  });

  it("scopes the re-read to the credential's id, org, and workspace", async () => {
    const where = installDb([
      [credential],
      [{ status: "active", expiresAt: new Date(EXPIRES) }],
    ]);
    mocks.mcpAuth.mockResolvedValue("REDIRECT");

    await run();

    expect(where[1]).toEqual([
      "and",
      ["eq", "cred.id", "cred-1"],
      ["eq", "cred.orgId", "org-1"],
      ["eq", "cred.workspaceId", "ws-1"],
    ]);
  });

  it("leaves a credential another path refreshed after it was selected", async () => {
    installDb([
      [credential],
      [{ status: "active", expiresAt: new Date("2026-09-30T13:20:00.000Z") }],
    ]);
    mocks.mcpAuth.mockResolvedValue("REDIRECT");

    const result = await run();

    expect(mocks.markCredentialNeedsReauth).not.toHaveBeenCalled();
    expect(result).toEqual({
      total: 1,
      refreshed: 0,
      markedReauth: 0,
      handledElsewhere: 1,
    });
  });

  it("does not mark a credential that is no longer active", async () => {
    installDb([
      [credential],
      [{ status: "needs_reauth", expiresAt: new Date(EXPIRES) }],
    ]);
    mocks.mcpAuth.mockResolvedValue("REDIRECT");

    const result = await run();

    expect(mocks.markCredentialNeedsReauth).not.toHaveBeenCalled();
    expect(result).toMatchObject({ markedReauth: 0, handledElsewhere: 1 });
  });

  it("skips a row with no endpoint URL", async () => {
    installDb([[{ ...credential, endpointUrl: null }]]);

    const result = await run();

    expect(mocks.mcpAuth).not.toHaveBeenCalled();
    expect(result).toEqual({
      total: 1,
      refreshed: 0,
      markedReauth: 0,
      handledElsewhere: 0,
    });
  });
});
