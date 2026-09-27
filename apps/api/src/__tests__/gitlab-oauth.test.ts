/**
 * Unit tests for src/routes/v1/gitlab-oauth.ts
 *
 * Covers POST /v1/:org/connections/steering/gitlab, which checks a GitLab
 * group access token against GitLab and stores it as the organization's
 * `gitlab_steering` account:
 *   - a token that passes every check → 200 with the group, stored, and each
 *     scope that waits on GitLab gets its provision event again
 *   - each refusal GitLab's answers lead to → 422 with its code
 *   - a 429 → 503, and any other GitLab failure → 502 with a status-only log
 *   - a body that is not JSON or fails the schema → 400, with no GitLab call
 *   - a member, or a caller with no user → 403
 *   - a failed store or resend → 500
 *   - the token never appears in a response or a log line
 *
 * GitLab is mocked through the global fetch, routed by URL.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  // Auth
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  // Billing
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
  // DB
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
  // Crypto
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  createIngestionCryptoAdapter: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
  // Env
  requireEnv: vi.fn(),
  // Role gate on the steering connect
  assertOrgRole: vi.fn(),
  // The provision event the connect sends again for each waiting scope
  startSteeringRepoProvision: vi.fn(),
  // Fetch, which answers for GitLab
  fetch: vi.fn(),
}));

// ── module mocks (must be hoisted before imports) ─────────────────────────────

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  // Keep the real exports such as CapabilityError, which the error
  // middleware checks with instanceof.
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...real,
    invoke: vi.fn(),
    clearHandlersForTests: vi.fn(),
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    verifyStripeSignature: mocks.verifyStripeSignature,
    processStripeEvent: mocks.processStripeEvent,
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileNotFoundError";
    }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) {
      super(msg);
      this.name = "FileForbiddenError";
    }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = {
    ...real,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// Mocked rather than driven through the db seam, so the suites below count
// only the store and the scope reads on withSystemDb.
vi.mock("@oxagen/iam/org-role", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/iam/org-role")>();
  return { ...real, assertOrgRole: mocks.assertOrgRole };
});

vi.mock("@oxagen/crypto", () => ({
  encrypt: mocks.encrypt,
  decrypt: mocks.decrypt,
  createIngestionCryptoAdapter: mocks.createIngestionCryptoAdapter,
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
}));

vi.mock("@oxagen/config/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/config/env")>();
  return { ...real, requireEnv: mocks.requireEnv };
});

vi.mock("@oxagen/inngest-functions/client", () => ({
  inngest: { send: vi.fn() },
}));
vi.mock("@oxagen/inngest-functions", () => ({
  inngest: { send: vi.fn(), createFunction: vi.fn() },
  functions: [],
}));
vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: vi.fn(() => ({ verifyWebhook: vi.fn().mockReturnValue(true) })),
}));

// MUST resolve a promise: the GitHub callbacks chain `.catch()` on the result.
vi.mock("../routes/v1/github-installations", () => ({
  upsertGithubInstallation: vi.fn().mockResolvedValue(undefined),
}));

// The connect reads each scope's state with the real helpers and sends the
// provision event through this one, so a test counts the sends without
// queueing a job.
vi.mock("@oxagen/handlers/steering_repo.provision", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("@oxagen/handlers/steering_repo.provision")
    >();
  return {
    ...real,
    startSteeringRepoProvision: mocks.startSteeringRepoProvision,
  };
});

global.fetch = mocks.fetch as unknown as typeof fetch;

import { HandlerError, ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import { REAUTHORIZE } from "@oxagen/handlers/steering_repo.provision";
import { app } from "../app";
import { logger } from "../middleware/logger";
import {
  makeRequest,
  bearerHeader,
  makeApiKeyOk,
  TEST_ORG_ID,
} from "./_helpers";

// ── constants ─────────────────────────────────────────────────────────────────

const GITLAB_PATH = "/v1/test-org/connections/steering/gitlab";
const GITLAB_API = "https://gitlab.com/api/v4";
const USER_ID = "user-id-test";
const TOKEN = "glpat-steering-test-token-0123456789";
const GROUP_PATH = "acme/platform";
const GROUP_ID = 55;
const BOT_USER_ID = 777;

/** What the Owner or Admin role check is asked for. */
const STEERING_REQUIREMENT = { org: ["Owner", "Admin"] } as const;

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * One GitLab answer: a status with a JSON body, a status with raw text, or a
 * fetch that throws, as a network failure does.
 */
type GitlabReply = { status: number; body?: unknown; text?: string } | "reject";

/** GitLab's answer for each of the four reads the check makes. */
interface GitlabReplies {
  self: GitlabReply;
  user: GitlabReply;
  group: GitlabReply;
  member: GitlabReply;
}

/** A group access token with the api scope and the Maintainer role. */
const GOOD_REPLIES: GitlabReplies = {
  self: {
    status: 200,
    body: {
      active: true,
      revoked: false,
      scopes: ["api", "read_repository"],
      expires_at: "2027-01-31",
    },
  },
  user: { status: 200, body: { id: BOT_USER_ID } },
  group: { status: 200, body: { id: GROUP_ID, full_path: GROUP_PATH } },
  member: { status: 200, body: { access_level: 40 } },
};

/** A fetch Response with the fields the route reads. */
function gitlabResponse(reply: { status: number; body?: unknown; text?: string }) {
  const text =
    reply.text ??
    (reply.body === undefined ? "" : JSON.stringify(reply.body));
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    text: async () => text,
    json: async () => reply.body,
  };
}

/** Answer each GitLab read by its URL, with `overrides` replacing the good answers. */
function routeGitlab(overrides: Partial<GitlabReplies> = {}) {
  const replies: GitlabReplies = { ...GOOD_REPLIES, ...overrides };
  mocks.fetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    let reply: GitlabReply;
    if (url.includes("/personal_access_tokens/self")) reply = replies.self;
    else if (url.endsWith("/api/v4/user")) reply = replies.user;
    else if (url.includes("/members/all/")) reply = replies.member;
    else if (url.includes("/groups/")) reply = replies.group;
    else
      throw new Error(
        `The GitLab suite has no answer for ${url}. Add one to routeGitlab.`,
      );
    if (reply === "reject") throw new TypeError("fetch failed");
    return gitlabResponse(reply);
  });
}

function postGitlab(body: unknown) {
  return app.fetch(
    makeRequest(GITLAB_PATH, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_test"),
        "content-type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

type Tx = Record<string, unknown>;
type DbCallback = (tx: Tx) => Promise<unknown>;

/** A tx whose insert returns `returned`, recording the values it inserted. */
function makeInsertTx(returned: unknown[]) {
  const captured: { values?: Record<string, unknown> } = {};
  const insertChain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    returning: vi.fn().mockResolvedValue(returned),
  };
  insertChain.values.mockImplementation((arg: Record<string, unknown>) => {
    captured.values = arg;
    return insertChain;
  });
  insertChain.onConflictDoUpdate.mockReturnValue(insertChain);
  const tx: Tx = { insert: vi.fn().mockReturnValue(insertChain) };
  return { tx, captured };
}

/**
 * A tx for a select that answers `rows`, whether the query ends at `.where()`
 * or at `.limit()`. The workspace read awaits `.where()` directly.
 */
function makeRowsTx(rows: unknown[]): Tx {
  const selectChain = { from: vi.fn(), where: vi.fn() };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockImplementation(() =>
    Object.assign(Promise.resolve(rows), {
      limit: vi.fn().mockResolvedValue(rows),
    }),
  );
  return { select: vi.fn().mockReturnValue(selectChain) };
}

/** Answer the next withSystemDb calls with these txs, in order. */
function queueSystemDb(...txs: Tx[]) {
  for (const tx of txs) {
    mocks.withSystemDb.mockImplementationOnce((fn: DbCallback) => fn(tx));
  }
}

/** A `steering_repo` setting stopped for a new authorization on `provider`. */
function reauthorizeState(provider: "github" | "gitlab") {
  return {
    status: "blocked",
    step: "pick_connection",
    failed_step: "create_repository",
    error: { code: REAUTHORIZE, message: "Authorize the host again." },
    provider,
    attempt: 1,
    candidate: null,
    repository: null,
    commit_sha: null,
    deployment_id: null,
    binding_id: null,
    updated_at: "2026-09-27T00:00:00.000Z",
  };
}

/** Every argument any logger method was called with, as one string. */
function loggedText(): string {
  return JSON.stringify([
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
    vi.mocked(logger.info).mock.calls,
  ]);
}

type ErrorBody = { error?: { code?: string; message?: string } };

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk({ userId: USER_ID }));
  mocks.requireEnv.mockReturnValue({});
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.startSteeringRepoProvision.mockResolvedValue("provisioning");

  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "ingestion:env:v1",
  });
  mocks.encrypt.mockResolvedValue(Buffer.from("encrypted-token"));

  // With nothing queued, the upsert returns no row and every read is empty.
  const emptyInsert = (): Tx => makeInsertTx([]).tx;
  mocks.withSystemDb.mockImplementation((fn: DbCallback) =>
    fn({ ...emptyInsert(), ...makeRowsTx([]) }),
  );
  mocks.withTenantDb.mockImplementation((fn: DbCallback) =>
    fn(makeRowsTx([])),
  );

  routeGitlab();
});

// ── POST /v1/:org/connections/steering/gitlab ─────────────────────────────────

describe("POST /v1/:org/connections/steering/gitlab", () => {
  it("stores a token that passes every check and resends each scope that waits on GitLab", async () => {
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(
      insert.tx,
      makeRowsTx([{ settings: {} }]),
      makeRowsTx([
        { id: "ws-gitlab", settings: { steering_repo: reauthorizeState("gitlab") } },
        { id: "ws-github", settings: { steering_repo: reauthorizeState("github") } },
        {
          id: "ws-ready",
          settings: {
            steering_repo: { ...reauthorizeState("gitlab"), status: "ready" },
          },
        },
        {
          id: "ws-picking",
          settings: { steering_repo: { status: "provisioning", step: null } },
        },
      ]),
    );

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      group_id: GROUP_ID,
      group_path: GROUP_PATH,
    });
    expect(text).not.toContain(TOKEN);

    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      {
        orgId: TEST_ORG_ID,
        workspaceId: ORG_ONLY_WORKSPACE_ID,
        userId: USER_ID,
      },
      STEERING_REQUIREMENT,
    );

    // Four reads, in order, each with the token in the PRIVATE-TOKEN header.
    const calls = mocks.fetch.mock.calls as [
      string,
      { method?: string; headers: Record<string, string> },
    ][];
    expect(calls.map(([url]) => url)).toEqual([
      `${GITLAB_API}/personal_access_tokens/self`,
      `${GITLAB_API}/user`,
      `${GITLAB_API}/groups/acme%2Fplatform?with_projects=false`,
      `${GITLAB_API}/groups/${GROUP_ID}/members/all/${BOT_USER_ID}`,
    ]);
    for (const [, init] of calls) {
      expect(init.method).toBe("GET");
      expect(init.headers["PRIVATE-TOKEN"]).toBe(TOKEN);
    }

    expect(mocks.encrypt).toHaveBeenCalledTimes(1);
    expect(mocks.encrypt).toHaveBeenCalledWith(TOKEN, "ingestion:env:v1", {
      adapter: {},
    });
    expect(insert.captured.values).toMatchObject({
      orgId: TEST_ORG_ID,
      provider: "gitlab_steering",
      providerUserId: String(GROUP_ID),
      providerUserName: GROUP_PATH,
      providerUserEmail: null,
      refreshTokenEnc: null,
      tokenType: "Bearer",
      scopes: ["api", "read_repository"],
      expiresAt: new Date("2027-01-31"),
    });

    // The organization has no state, so it waits on either host. Of the
    // workspaces, the one stopped for a GitLab authorization and the one
    // still picking a connection wait. The GitHub one and the ready one do not.
    expect(mocks.startSteeringRepoProvision).toHaveBeenCalledTimes(3);
    expect(mocks.startSteeringRepoProvision).toHaveBeenNthCalledWith(
      1,
      { orgId: TEST_ORG_ID, workspaceId: null, actorUserId: USER_ID },
      expect.objectContaining({ status: "provisioning", step: null }),
    );
    expect(mocks.startSteeringRepoProvision).toHaveBeenNthCalledWith(
      2,
      { orgId: TEST_ORG_ID, workspaceId: "ws-gitlab", actorUserId: USER_ID },
      expect.objectContaining({ status: "blocked", provider: "gitlab" }),
    );
    expect(mocks.startSteeringRepoProvision).toHaveBeenNthCalledWith(
      3,
      { orgId: TEST_ORG_ID, workspaceId: "ws-picking", actorUserId: USER_ID },
      expect.objectContaining({ status: "provisioning", step: null }),
    );

    expect(loggedText()).not.toContain(TOKEN);
  });

  it("stores no expiry for a token that does not expire", async () => {
    routeGitlab({
      self: {
        status: 200,
        body: {
          active: true,
          revoked: false,
          scopes: ["api"],
          expires_at: null,
        },
      },
    });
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([]), makeRowsTx([]));

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(200);
    expect(insert.captured.values?.expiresAt).toBeNull();
    expect(insert.captured.values?.scopes).toEqual(["api"]);
    // No organization row and no workspaces: nothing to resend.
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
  });

  it("reads a numeric group by its id", async () => {
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([]), makeRowsTx([]));

    const res = await postGitlab({ group: GROUP_ID, token: TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      group_id: GROUP_ID,
      group_path: GROUP_PATH,
    });
    const urls = mocks.fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(
      `${GITLAB_API}/groups/${GROUP_ID}?with_projects=false`,
    );
  });

  it("trims the group and the token before using them", async () => {
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([]), makeRowsTx([]));

    const res = await postGitlab({
      group: `  ${GROUP_PATH} `,
      token: ` ${TOKEN}\n`,
    });

    expect(res.status).toBe(200);
    const calls = mocks.fetch.mock.calls as [
      string,
      { headers: Record<string, string> },
    ][];
    expect(calls[0]?.[1].headers["PRIVATE-TOKEN"]).toBe(TOKEN);
    expect(calls.map(([url]) => url)).toContain(
      `${GITLAB_API}/groups/acme%2Fplatform?with_projects=false`,
    );
  });

  it.each<{ name: string; replies: Partial<GitlabReplies>; code: string }>([
    {
      name: "GitLab refuses the token",
      replies: { self: { status: 401, body: { message: "401 Unauthorized" } } },
      code: "gitlab_token_invalid",
    },
    {
      name: "the token is revoked",
      replies: {
        self: {
          status: 200,
          body: { active: false, revoked: true, scopes: ["api"] },
        },
      },
      code: "gitlab_token_invalid",
    },
    {
      name: "the token is no longer active",
      replies: {
        self: {
          status: 200,
          body: { active: false, revoked: false, scopes: ["api"] },
        },
      },
      code: "gitlab_token_invalid",
    },
    {
      name: "the token lacks the api scope",
      replies: {
        self: {
          status: 200,
          body: { active: true, revoked: false, scopes: ["read_api"] },
        },
      },
      code: "gitlab_token_insufficient",
    },
    {
      name: "GitLab will not describe the token (403)",
      replies: { self: { status: 403, body: { message: "403 Forbidden" } } },
      code: "gitlab_token_insufficient",
    },
    {
      name: "GitLab will not describe the token (404)",
      replies: { self: { status: 404, body: { message: "404 Not Found" } } },
      code: "gitlab_token_insufficient",
    },
    {
      name: "GitLab refuses the token on /user",
      replies: { user: { status: 401, body: { message: "401 Unauthorized" } } },
      code: "gitlab_token_invalid",
    },
    {
      name: "the token cannot see the group (404)",
      replies: {
        group: { status: 404, body: { message: "404 Group Not Found" } },
      },
      code: "gitlab_group_unreachable",
    },
    {
      name: "the token cannot see the group (403)",
      replies: { group: { status: 403, body: { message: "403 Forbidden" } } },
      code: "gitlab_group_unreachable",
    },
    {
      name: "the group answer has no full path",
      replies: { group: { status: 200, body: { id: GROUP_ID } } },
      code: "gitlab_group_unreachable",
    },
    {
      name: "the token's role is Developer",
      replies: { member: { status: 200, body: { access_level: 30 } } },
      code: "gitlab_token_insufficient",
    },
    {
      name: "the token's user is not a member of the group",
      replies: { member: { status: 404, body: { message: "404 Not found" } } },
      code: "gitlab_token_insufficient",
    },
  ])("answers 422 $code when $name", async ({ replies, code }) => {
    routeGitlab(replies);

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(422);
    const text = await res.text();
    const body = JSON.parse(text) as ErrorBody;
    expect(body.error?.code).toBe(code);
    expect(body.error?.message).toBeTruthy();
    expect(text).not.toContain(TOKEN);
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(TOKEN);
  });

  it("answers 503 gitlab_rate_limited when GitLab limits requests", async () => {
    routeGitlab({ group: { status: 429, body: { message: "Retry later" } } });

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("gitlab_rate_limited");
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("answers 502 gitlab_unavailable and logs only the status when GitLab fails", async () => {
    routeGitlab({ group: { status: 500, body: { message: TOKEN } } });

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(502);
    const text = await res.text();
    expect((JSON.parse(text) as ErrorBody).error?.code).toBe(
      "gitlab_unavailable",
    );
    expect(text).not.toContain(TOKEN);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { orgId: TEST_ORG_ID, status: 500 },
      "Checking a GitLab steering token failed",
    );
    expect(loggedText()).not.toContain(TOKEN);
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("answers 502 gitlab_unavailable when GitLab does not answer", async () => {
    routeGitlab({ self: "reject" });

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("gitlab_unavailable");
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { orgId: TEST_ORG_ID, status: null },
      "Checking a GitLab steering token failed",
    );
  });

  it("answers 502 gitlab_unavailable when GitLab's answer is not JSON", async () => {
    routeGitlab({ self: { status: 200, text: "<html>maintenance</html>" } });

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("gitlab_unavailable");
  });

  it("answers 502 gitlab_unavailable when /user names no user", async () => {
    routeGitlab({ user: { status: 200, body: {} } });

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(502);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("gitlab_unavailable");
  });

  it.each<{ name: string; body: unknown; field: string }>([
    {
      name: "a group path with a space",
      body: { group: "acme platform", token: TOKEN },
      field: "group",
    },
    {
      name: "a group id of zero",
      body: { group: 0, token: TOKEN },
      field: "group",
    },
    {
      name: "a missing token",
      body: { group: GROUP_PATH },
      field: "token",
    },
    {
      name: "a token that is only spaces",
      body: { group: GROUP_PATH, token: "   " },
      field: "token",
    },
    {
      name: "a token longer than 512 characters",
      body: { group: GROUP_PATH, token: `${TOKEN}${"x".repeat(512)}` },
      field: "token",
    },
  ])("answers 400 to $name, without calling GitLab or echoing the token", async ({ body, field }) => {
    const res = await postGitlab(body);

    expect(res.status).toBe(400);
    const text = await res.text();
    const parsed = JSON.parse(text) as ErrorBody;
    expect(parsed.error?.code).toBe("validation_error");
    // The message always names both fields in its first sentence, so check
    // the clause that lists the ones that failed.
    expect(parsed.error?.message).toContain(`Check: ${field}.`);
    expect(text).not.toContain(TOKEN);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not JSON", async () => {
    const res = await postGitlab(`group=${GROUP_PATH}&token=${TOKEN}`);

    expect(res.status).toBe(400);
    const text = await res.text();
    const body = JSON.parse(text) as ErrorBody;
    expect(body.error?.code).toBe("validation_error");
    expect(body.error?.message).toBe(
      "The body must be JSON with a group and a token.",
    );
    expect(text).not.toContain(TOKEN);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("answers 403 to an org member, before reading the body or calling GitLab", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(
      new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "Requires one of the org roles Owner, Admin",
      }),
    );

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect((JSON.parse(text) as ErrorBody).error?.code).toBe("forbidden");
    expect(text).not.toContain(TOKEN);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("answers 403 when the request carries no user, before checking a role", async () => {
    mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("forbidden");
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("answers 500 store_failed when the upsert returns no row, and resends nothing", async () => {
    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect((JSON.parse(text) as ErrorBody).error?.code).toBe("store_failed");
    expect(text).not.toContain(TOKEN);
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(TOKEN);
  });

  it("answers 500 store_failed when the upsert throws", async () => {
    mocks.withSystemDb.mockImplementationOnce(() =>
      Promise.reject(new Error("connection reset")),
    );

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("store_failed");
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
  });

  it("answers 500 provision_resend_failed when a scope read throws after the store", async () => {
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx);
    mocks.withSystemDb.mockImplementationOnce(() =>
      Promise.reject(new Error("connection reset")),
    );

    const res = await postGitlab({ group: GROUP_PATH, token: TOKEN });

    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("provision_resend_failed");
    expect(insert.captured.values?.provider).toBe("gitlab_steering");
  });
});
