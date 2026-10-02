/**
 * Unit tests for src/routes/v1/github-oauth.ts
 *
 * Covers:
 * - GET /v1/:org/:ws/connections/github/auth-url
 *   - missing connectionId → 400
 *   - missing env vars → 503
 *   - happy path → returns authUrl with correct client_id, scope, state, redirect_uri
 *   - state HMAC is a sha256 hex of the state JSON
 *   - state is base64url-encoded JSON
 *
 * - GET /oauth/github/callback
 *   - missing code or state → 400
 *   - missing env vars → 503
 *   - state with bad base64url → 400 (via the signature check; see the test)
 *   - state HMAC mismatch → 400
 *   - correctly-signed state that is not JSON → 400
 *   - expired state → 400
 *   - GitHub token exchange failure (non-200) → 502
 *   - GitHub token exchange error field → 400
 *   - happy path → stores tokens + redirects to app with setup=github query
 *
 * - GET /v1/:org/:ws/connections/github/installations
 *   - missing connectionId → 400
 *   - connection not found → 404
 *   - GitHub API error → 502
 *   - happy path → returns installations list
 *   - paginates when total_count > 100
 *
 * - GET /v1/:org/:ws/connections/github/installations/:id/repositories
 *   - missing connectionId → 400
 *   - connection not found → 404
 *   - GitHub API error → 502
 *   - happy path → returns repositories list with totalCount
 *
 * - GET /v1/:org/connections/steering/github (the steering connect start)
 *   - each unset GITHUB_APP_* key → 503 naming it
 *   - a member, or a caller with no user → 403
 *   - return_to that is not a path on the app → 400
 *   - install and authorize redirects carry a signed steering state and no
 *     redirect_uri; the retired app parameter is ignored (ADR-228)
 *
 * - GET /oauth/github/callback with a steering state (ADR-228)
 *   - each unset key → 503; a bad or expired state → 400
 *   - a state signed for any other purpose, or with malformed fields → 400
 *   - records the installation, stores the token as github_steering, and
 *     resends each waiting scope
 *   - every outcome lands on the app's /github/steering with return_to and
 *     the outcome on its query, never on return_to itself (#5151)
 *   - keeps the installation the install leg named, only when the owner's
 *     token lists it on a GitHub organization
 *
 * - GET /oauth/github/steering (retired) → 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";

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
  // Role gate on the settings connect legs
  assertOrgRole: vi.fn(),
  // The provision event the steering connect sends again for each waiting scope
  startSteeringRepoProvision: vi.fn(),
  // The write that keeps the installation the install leg named
  keepSteeringConnection: vi.fn(),
  moveSteeringInstallation: vi.fn(),
  // Fetch
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
  // Partial mock: stub invoke/clearHandlersForTests but KEEP real exports such
  // as CapabilityError — error.ts does `err instanceof CapabilityError`, which
  // throws if the class is missing from the mock.
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// The role gate the settings-connect legs run before they mint a signed state.
// Mocked rather than driven through the db seam so that suites counting
// withSystemDb / withTenantDb calls keep counting what they came to count.
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
  return {
    ...real,
    requireEnv: mocks.requireEnv,
  };
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

// The github_installations registry upsert has its own dedicated suite
// (github-installations.test.ts). Stub it to a no-op so the callback logic tests
// aren't perturbed by its extra withSystemDb call in the resolution sequence.
// MUST resolve a promise — the callback chains `.catch()` on the result.
vi.mock("../routes/v1/github-installations", () => ({
  upsertGithubInstallation: vi.fn().mockResolvedValue(undefined),
}));

// The steering connect reads each scope's state with the real helpers and
// sends the provision event through this one, so a test counts the sends
// without queueing a job.
vi.mock("@oxagen/handlers/steering_repo.provision", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("@oxagen/handlers/steering_repo.provision")
    >();
  return {
    ...real,
    startSteeringRepoProvision: mocks.startSteeringRepoProvision,
    keepSteeringConnection: mocks.keepSteeringConnection,
    moveSteeringInstallation: mocks.moveSteeringInstallation,
  };
});

// Stub global fetch for GitHub API calls
global.fetch = mocks.fetch as unknown as typeof fetch;

import { HandlerError, ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen";
import { REAUTHORIZE } from "@oxagen/handlers/steering_repo.provision";
import { app } from "../app";
import { upsertGithubInstallation } from "../routes/v1/github-installations";
import {
  makeRequest,
  bearerHeader,
  makeApiKeyOk,
  TEST_ORG_ID,
  TEST_WORKSPACE_ID,
} from "./_helpers";

// ── constants ─────────────────────────────────────────────────────────────────

const ORG = "test-org";
const WS = "test-ws";
const BASE = `/v1/${ORG}/${WS}/connections/github`;
const CALLBACK_PATH = "/oauth/github/callback";

const STATE_SECRET = "test-state-secret-32-bytes-long!1";
const CLIENT_ID = "Iv1.test_github_client_id";
const CLIENT_SECRET = "test_github_client_secret";
const APP_URL = "https://app.test.oxagen.ai";
const API_URL = "https://api.test.oxagen.ai";

const APP_SLUG = "oxagen-test";

/**
 * The two role requirements `/auth-url` and `/status` assert, spelled out here
 * so a test can say WHICH one a leg asked for rather than only that it asked.
 *
 * `SETTINGS_REQUIREMENT` is what `attach_github_installation`,
 * `get_main_repository` and `list_installation_repositories` admit (org only:
 * their contracts carry `workspace: {}`); `CONNECTION_REQUIREMENT` is what
 * `create_connection` and `delete_connection` admit.
 */
const SETTINGS_REQUIREMENT = { org: ["Owner", "Admin"] } as const;
const CONNECTION_REQUIREMENT = {
  org: ["Owner", "Admin"],
  workspace: ["Owner"],
} as const;

const DEFAULT_ENV = {
  GITHUB_APP_CLIENT_ID: CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
  GITHUB_APP_INSTALL_STATE_SECRET: STATE_SECRET,
  GITHUB_APP_SLUG: APP_SLUG,
  NEXT_PUBLIC_APP_URL: APP_URL,
  NEXT_PUBLIC_API_URL: API_URL,
};

// ── helpers ───────────────────────────────────────────────────────────────────

function authGet(path: string) {
  return app.fetch(
    makeRequest(path, { headers: { authorization: bearerHeader("oxk_test") } }),
  );
}

/**
 * Build a mock Drizzle chain for withTenantDb / withSystemDb.
 * Supports .select().from().innerJoin().where().limit() patterns.
 * Also supports .insert().values().onConflictDoUpdate().returning() patterns.
 */
function makeTxChain(rows: unknown[]) {
  const updateChain = {
    set: vi.fn(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  updateChain.set.mockReturnValue(updateChain);

  const insertChain = {
    values: vi.fn(),
    onConflictDoUpdate: vi.fn(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  insertChain.values.mockReturnValue(insertChain);
  insertChain.onConflictDoUpdate.mockReturnValue(insertChain);

  const selectChain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.innerJoin.mockReturnValue(selectChain);
  selectChain.where.mockReturnValue(selectChain);
  selectChain.orderBy.mockReturnValue(selectChain);

  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    execute: vi.fn().mockResolvedValue([]),
  };
}

type TxLike = ReturnType<typeof makeTxChain>;
type DbFn = (fn: (tx: TxLike) => Promise<unknown>) => Promise<unknown>;

/**
 * A tx that records what the settings-level install attach did: the predicate
 * its github-connection lookup ran, and the INSERT values or UPDATE set it
 * followed with. `selectRows` is what that lookup answers — `[]` for a
 * workspace with no GitHub connection yet.
 */
function makeCapturingTx(selectRows: unknown[]) {
  const captured: {
    selectWhere?: unknown;
    insertValues?: Record<string, unknown>;
    updateSet?: Record<string, unknown>;
  } = {};

  const selectChain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(selectRows),
  };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockImplementation((arg: unknown) => {
    captured.selectWhere = arg;
    return selectChain;
  });
  selectChain.orderBy.mockReturnValue(selectChain);

  const insertChain = {
    values: vi.fn((arg: Record<string, unknown>) => {
      captured.insertValues = arg;
      return insertChain;
    }),
  };

  const updateChain: {
    set: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
  } = {
    set: vi.fn(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  updateChain.set.mockImplementation((arg: Record<string, unknown>) => {
    captured.updateSet = arg;
    return updateChain;
  });

  const tx = {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    execute: vi.fn().mockResolvedValue([]),
  };
  return { tx: tx as unknown as TxLike, captured };
}

/**
 * Every bound parameter value in a Drizzle condition, walked through
 * `queryChunks` only — the table/column objects hanging off a chunk are
 * circular, so a general deep walk would not terminate.
 */
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || typeof node !== "object") return out;
  const record = node as Record<string, unknown>;
  const chunks = record["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) boundParams(chunk, out);
    return out;
  }
  if ("value" in record && "encoder" in record) out.push(record["value"]);
  return out;
}

/** Build a valid state string (base64url JSON + "." + HMAC). */
function buildValidState(
  overrides: Partial<{
    orgId: string;
    workspaceId: string;
    connectionId: string | null;
    returnTo: "settings" | "sources";
    expiresAt: number;
    nonce: string;
  }> = {},
): string {
  const stateJson = JSON.stringify({
    orgId: "org-id-test",
    workspaceId: "ws-id-test",
    connectionId: "con_ABC",
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: "test-nonce-uuid",
    ...overrides,
  });
  const hmac = createHmac("sha256", STATE_SECRET)
    .update(stateJson)
    .digest("hex");
  const encoded = Buffer.from(stateJson).toString("base64url");
  return `${encoded}.${hmac}`;
}

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Auth: API key resolves org+workspace
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());

  // Env: return DEFAULT_ENV by default
  mocks.requireEnv.mockReturnValue(DEFAULT_ENV);

  // Role: an Owner by default, so the settings-connect legs mint their state.
  // The refusal is asserted in its own suite, where it is the subject.
  mocks.assertOrgRole.mockResolvedValue("Owner");

  // Provision: the send succeeds and the scope keeps provisioning.
  mocks.startSteeringRepoProvision.mockResolvedValue("provisioning");
  mocks.keepSteeringConnection.mockResolvedValue(true);
  mocks.moveSteeringInstallation.mockResolvedValue(null);

  // Crypto: simple pass-through stubs
  mocks.createIngestionCryptoAdapter.mockReturnValue({
    adapter: {},
    keyId: "ingestion:env:v1",
  });
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
    adapter: {},
    keyId: "ingestion:env:v1",
  });
  mocks.encrypt.mockResolvedValue(Buffer.from("encrypted-token"));
  mocks.decrypt.mockResolvedValue(Buffer.from("decrypted-access-token"));

  // DB: return empty by default
  mocks.withTenantDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
    fn(makeTxChain([]) as TxLike),
  );
  mocks.withSystemDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
    fn(makeTxChain([]) as TxLike),
  );

  // Fetch: default to 200 OK JSON
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
});

// ── GET /connections/github/auth-url ──────────────────────────────────────────

describe("GET /connections/github/auth-url", () => {
  // The connection-named leg resolves the connection before it signs it into a
  // state, so every `?connectionId=` case below needs one that resolves. The
  // refusal of an id that does not has its own test, where it is the subject.
  beforeEach(() => {
    mocks.withTenantDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ id: "conn-uuid-1" }]) as TxLike),
    );
  });

  it("works WITHOUT a connectionId (settings-level connect) and encodes a null connectionId", async () => {
    // The install lives in workspace settings (1 workspace = 1 app install),
    // so auth-url does not require a pre-created source_connection.
    const res = await authGet(`${BASE}/auth-url?returnTo=settings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string };
    expect(body.authUrl).toContain(
      `github.com/apps/${APP_SLUG}/installations/new`,
    );

    const stateParam = new URL(body.authUrl).searchParams.get("state")!;
    const encoded = stateParam.slice(0, stateParam.lastIndexOf("."));
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { connectionId: string | null; returnTo: string };
    expect(payload.connectionId).toBeNull();
    expect(payload.returnTo).toBe("settings");
  });

  /**
   * Who may start a SETTINGS-level connect (#3233 review, P1).
   *
   * The mounted middleware establishes workspace MEMBERSHIP; it says nothing
   * about role. `attach_github_installation`, `get_main_repository` and
   * `list_installation_repositories` are all org Owner/Admin, so without a
   * gate here an ordinary member reached the same write one layer down: ask
   * this route for a settings state, complete the identity leg as themselves,
   * and the callback attaches an installation THEY reach onto the
   * workspace's authoritative GitHub connection — replacing the credentials
   * every repository operation runs through. Two paths to one write, only one
   * of them gated.
   */
  describe("the settings leg is Owner/Admin only", () => {
    it("refuses a member, and mints no state for them", async () => {
      mocks.assertOrgRole.mockRejectedValueOnce(
        new HandlerError({
          code: "forbidden",
          reason: "org_role_required",
          message: "Requires one of the org roles Owner, Admin",
        }),
      );
      const res = await authGet(`${BASE}/auth-url?returnTo=settings`);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("forbidden");
      // Nothing that could be carried to GitHub came back.
      expect(JSON.stringify(body)).not.toContain("github.com");
    });

    it("checks the org roles the capabilities admit, for this org and workspace", async () => {
      await authGet(`${BASE}/auth-url?returnTo=settings`);
      expect(mocks.assertOrgRole).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG_ID,
          workspaceId: TEST_WORKSPACE_ID,
        }),
        SETTINGS_REQUIREMENT,
      );
    });

    for (const role of ["Owner", "Admin"] as const) {
      it(`mints a state for an ${role}`, async () => {
        mocks.assertOrgRole.mockResolvedValueOnce(role);
        const res = await authGet(`${BASE}/auth-url?returnTo=settings`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { authUrl: string };
        expect(new URL(body.authUrl).searchParams.get("state")).not.toBeNull();
      });
    }

    it("refuses a caller with no signed-in user at all", async () => {
      // An API key identifies no human, and every capability on the other side
      // of this flow requires one. `assertOrgRole` answers `no_principal`.
      mocks.assertOrgRole.mockRejectedValueOnce(
        new HandlerError({
          code: "forbidden",
          reason: "no_principal",
          message: "No signed-in user on the request",
        }),
      );
      expect((await authGet(`${BASE}/auth-url?returnTo=settings`)).status).toBe(
        403,
      );
    });

    it("gates /status the same way — it mints a settings state too", async () => {
      mocks.assertOrgRole.mockRejectedValueOnce(
        new HandlerError({
          code: "forbidden",
          reason: "org_role_required",
          message: "Requires one of the org roles Owner, Admin",
        }),
      );
      const res = await authGet(`${BASE}/status`);
      expect(res.status).toBe(403);
      // Both of that route's URLs carry a settings state, so withholding the
      // response is what withholds them.
      expect(JSON.stringify(await res.json())).not.toContain("state=");
    });

    it("asks for the settings roles ONLY when the state names no connection", async () => {
      // The two legs reach two different writes, so they take two different
      // requirements. A state naming a connection must not be answered with
      // the settings one.
      await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
      expect(mocks.assertOrgRole).not.toHaveBeenCalledWith(
        expect.anything(),
        SETTINGS_REQUIREMENT,
      );
    });
  });

  /**
   * The gate keys on the connection, not on `returnTo` (#3233 review, P1).
   *
   * `returnTo` is a query parameter the caller types, and the CALLBACK does not
   * dispatch on it: it picks its write path from the resolved connection, so a
   * state naming no `connectionId` reaches the settings write — the workspace's
   * authoritative GitHub connection — whatever word `returnTo` carries.
   * `returnTo` only chooses the page the redirect lands on.
   *
   * So a gate reading `returnTo === "settings"` closed nothing: an ordinary
   * member asked for `?mode=identity&returnTo=sources` with no connectionId,
   * skipped the check, and got a validly signed state for the same write.
   */
  describe("the gate keys on the connection, not on returnTo", () => {
    const forbidden = () =>
      new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "Requires one of the org roles Owner, Admin",
      });

    // Every way to ask for a state that names no connection. All of them reach
    // the settings write, so all of them take the gate.
    const NULL_CONNECTION_QUERIES = [
      "returnTo=sources",
      "returnTo=sources&mode=identity",
      "mode=identity",
      "",
    ] as const;

    for (const query of NULL_CONNECTION_QUERIES) {
      const label = query || "(no query at all)";

      it(`refuses a member asking with ${label}, and mints no state`, async () => {
        mocks.assertOrgRole.mockRejectedValueOnce(forbidden());
        const res = await authGet(
          `${BASE}/auth-url${query ? `?${query}` : ""}`,
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("forbidden");
        expect(JSON.stringify(body)).not.toContain("github.com");
      });

      for (const role of ["Owner", "Admin"] as const) {
        it(`admits an ${role} asking with ${label}`, async () => {
          mocks.assertOrgRole.mockResolvedValueOnce(role);
          const res = await authGet(
            `${BASE}/auth-url${query ? `?${query}` : ""}`,
          );
          expect(res.status).toBe(200);
          const body = (await res.json()) as { authUrl: string };
          expect(
            new URL(body.authUrl).searchParams.get("state"),
          ).not.toBeNull();
        });
      }
    }

    it("checks the same org roles for a null-connection sources state", async () => {
      await authGet(`${BASE}/auth-url?returnTo=sources`);
      expect(mocks.assertOrgRole).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG_ID,
          workspaceId: TEST_WORKSPACE_ID,
        }),
        SETTINGS_REQUIREMENT,
      );
    });
  });

  /**
   * The LEGACY IN-WIZARD leg is gated too (#3233 review, P1 — the third pass at
   * this route, and the first to cover this leg).
   *
   * Two earlier gates spared `returnTo=sources` WITH a `connectionId`, each
   * time on the reasoning that the leg "keeps the authorization it already
   * has". It had none: the mounted middleware establishes workspace MEMBERSHIP
   * and nothing more, and `list_connections` admits a workspace Member, so a
   * Member could read an Owner-created connection's publicId and ask for a
   * state naming it.
   *
   * What that state buys, in the callback's `conn` branch: the connection's
   * `oauth_account_id` is repointed at whoever authorized the callback
   * (unconditional), its `deliveryConfig.installationId` is replaced with any
   * installation that account reaches, and its `status` is reset to
   * `pending_setup`. The installation id is what the platform App mints tokens
   * against. So the gate is `create_connection`'s own pair — org Owner/Admin,
   * or workspace Owner — and the route and the capability now give one answer.
   */
  describe("the leg that NAMES a connection takes the connection-setup roles", () => {
    const forbidden = () =>
      new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message:
          "Requires one of the org roles Owner, Admin or workspace roles Owner",
      });

    const NAMED_CONNECTION_QUERIES = [
      "connectionId=con_ABC",
      "connectionId=con_ABC&returnTo=sources",
      "connectionId=con_ABC&mode=identity",
      "connectionId=con_ABC&returnTo=sources&mode=identity",
    ] as const;

    for (const query of NAMED_CONNECTION_QUERIES) {
      it(`refuses a member asking with ${query}, and mints no state`, async () => {
        mocks.assertOrgRole.mockRejectedValueOnce(forbidden());
        const res = await authGet(`${BASE}/auth-url?${query}`);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe("forbidden");
        // Nothing that could be carried to GitHub came back.
        expect(JSON.stringify(body)).not.toContain("github.com");
      });
    }

    it("asks for exactly what create_connection admits, for this org and workspace", async () => {
      await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
      expect(mocks.assertOrgRole).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG_ID,
          workspaceId: TEST_WORKSPACE_ID,
        }),
        CONNECTION_REQUIREMENT,
      );
    });

    for (const role of ["Owner", "Admin"] as const) {
      it(`mints a state for an org ${role}`, async () => {
        mocks.assertOrgRole.mockResolvedValueOnce(role);
        const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { authUrl: string };
        expect(new URL(body.authUrl).searchParams.get("state")).not.toBeNull();
      });
    }

    it("mints a state for a workspace Owner", async () => {
      // `assertOrgRole` answers with the role that satisfied it, and the
      // workspace leg is the one `create_connection` names; the route must not
      // be tighter than the capability or the connection's own creator cannot
      // finish connecting it.
      mocks.assertOrgRole.mockResolvedValueOnce("Owner");
      const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
      expect(res.status).toBe(200);
      expect(mocks.assertOrgRole).toHaveBeenCalledWith(expect.anything(), {
        org: ["Owner", "Admin"],
        workspace: ["Owner"],
      });
    });

    it("refuses a caller with no signed-in user at all", async () => {
      mocks.assertOrgRole.mockRejectedValueOnce(
        new HandlerError({
          code: "forbidden",
          reason: "no_principal",
          message: "No signed-in user on the request",
        }),
      );
      expect(
        (await authGet(`${BASE}/auth-url?connectionId=con_ABC`)).status,
      ).toBe(403);
    });

    it("checks the role BEFORE it looks the connection up", async () => {
      // An unauthorized caller learns nothing about which connections exist,
      // and no work is done on their behalf.
      mocks.assertOrgRole.mockRejectedValueOnce(forbidden());
      await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
      expect(mocks.withTenantDb).not.toHaveBeenCalled();
    });
  });

  /**
   * A named connection is resolved before it is signed into a state.
   *
   * The callback fences the same lookup and 404s an id that does not resolve,
   * so the WRITE was already safe. What was not: a validly signed, ten-minute
   * bearer naming a connection of another workspace, or a deleted one, or none
   * at all, handed out to a caller and carried to GitHub before anything
   * refused it.
   */
  describe("the named connection must resolve in this org and workspace", () => {
    beforeEach(() => {
      mocks.withTenantDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([]) as TxLike),
      );
    });

    it("refuses a connectionId that resolves to nothing, and mints no state", async () => {
      const res = await authGet(`${BASE}/auth-url?connectionId=con_NOPE`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Connection not found");
      expect(JSON.stringify(body)).not.toContain("github.com");
    });

    it("refuses it on every returnTo and mode the caller can type", async () => {
      for (const query of [
        "connectionId=con_NOPE&returnTo=sources",
        "connectionId=con_NOPE&returnTo=settings",
        "connectionId=con_NOPE&mode=identity",
      ]) {
        const res = await authGet(`${BASE}/auth-url?${query}`);
        expect(res.status).toBe(404);
      }
    });

    it("fences the lookup on the publicId, this org and this workspace", async () => {
      const { tx, captured } = makeCapturingTx([]);
      mocks.withTenantDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
        fn(tx),
      );
      await authGet(`${BASE}/auth-url?connectionId=con_FENCED`);
      const params = boundParams(captured.selectWhere);
      expect(params).toContain("con_FENCED");
      expect(params).toContain(TEST_ORG_ID);
      expect(params).toContain(TEST_WORKSPACE_ID);
    });
  });

  it("returns 503 when GITHUB_APP_SLUG is missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not configured");
  });

  it("returns 503 when GITHUB_APP_INSTALL_STATE_SECRET is missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_INSTALL_STATE_SECRET: undefined,
    });
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(503);
  });

  it("returns the GitHub App installations/new URL with the app slug + state", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authUrl: string };
    // Install flow (not bare OAuth authorize) so a first-time user installs the
    // App AND GitHub round-trips our signed state back to the callback.
    expect(body.authUrl).toContain(
      `github.com/apps/${APP_SLUG}/installations/new`,
    );
    expect(body.authUrl).not.toContain("login/oauth/authorize");
    expect(body.authUrl).toContain("state=");
  });

  it("does NOT pass redirect_uri (the App's configured Callback URL is used)", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    const body = (await res.json()) as { authUrl: string };
    expect(body.authUrl).not.toContain("redirect_uri");
  });

  it("state encodes the connectionId + orgId + workspaceId as base64url JSON", async () => {
    const res = await authGet(`${BASE}/auth-url?connectionId=con_MYCONN`);
    const body = (await res.json()) as { authUrl: string };
    const urlStr = body.authUrl;
    const stateMatch = urlStr.match(/[?&]state=([^&]+)/);
    expect(stateMatch).not.toBeNull();

    const rawState = decodeURIComponent(stateMatch![1]!);
    // Format: "{base64url_json}.{hmac}"
    const dotIdx = rawState.lastIndexOf(".");
    expect(dotIdx).toBeGreaterThan(0);

    const encodedState = rawState.slice(0, dotIdx);
    const receivedHmac = rawState.slice(dotIdx + 1);

    const stateJson = Buffer.from(encodedState, "base64url").toString("utf8");
    const statePayload = JSON.parse(stateJson) as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      expiresAt: number;
      nonce: string;
    };

    expect(statePayload.connectionId).toBe("con_MYCONN");
    expect(statePayload.orgId).toBeDefined();
    expect(statePayload.workspaceId).toBeDefined();
    expect(statePayload.expiresAt).toBeGreaterThan(Date.now());

    // HMAC should match
    const expectedHmac = createHmac("sha256", STATE_SECRET)
      .update(stateJson)
      .digest("hex");
    expect(receivedHmac).toBe(expectedHmac);
  });

  it("expiresAt is ~10 minutes in the future", async () => {
    const before = Date.now();
    const res = await authGet(`${BASE}/auth-url?connectionId=con_ABC`);
    const after = Date.now();
    const body = (await res.json()) as { authUrl: string };

    const rawState = decodeURIComponent(
      body.authUrl.match(/[?&]state=([^&]+)/)![1]!,
    );
    const dotIdx = rawState.lastIndexOf(".");
    const stateJson = Buffer.from(
      rawState.slice(0, dotIdx),
      "base64url",
    ).toString("utf8");
    const { expiresAt } = JSON.parse(stateJson) as { expiresAt: number };

    expect(expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 100);
    expect(expiresAt).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 100);
  });
});

// ── GET /connections/github/status ────────────────────────────────────────────

describe("GET /connections/github/status", () => {
  it("returns 503 when the GitHub App is not configured", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(503);
  });

  it("reports not-connected (with an install URL) when the org has no GitHub OAuth account", async () => {
    // Default DB returns no oauth_accounts row → not connected, but the settings
    // UI still needs a connect URL.
    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      installations: unknown[];
      installUrl: string;
    };
    expect(body.connected).toBe(false);
    expect(body.installations).toHaveLength(0);
    expect(body.installUrl).toContain(
      `github.com/apps/${APP_SLUG}/installations/new`,
    );
  });

  it("reports connected with the installations the token can reach", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          {
            id: "oa1",
            accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" },
          },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        installations: [
          {
            id: 444,
            account: {
              login: "connected-org",
              type: "Organization",
              avatar_url: "https://gh.com/444",
            },
            repository_selection: "selected",
            html_url:
              "https://github.com/organizations/connected-org/settings/installations/444",
          },
        ],
      }),
    });

    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      installations: Array<{ accountLogin: string; htmlUrl: string | null }>;
      manageUrl: string;
      installUrl: string;
    };
    expect(body.connected).toBe(true);
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]!.accountLogin).toBe("connected-org");
    expect(body.installUrl).toContain("installations/new");
  });

  it("reports not-connected when the user token has been revoked (GitHub 401)", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          {
            id: "oa1",
            accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" },
          },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const res = await authGet(`${BASE}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
  });
});

// ── GET /oauth/github/callback ────────────────────────────────────────────────

describe("GET /oauth/github/callback", () => {
  function makeCallbackReq(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return app.fetch(makeRequest(`${CALLBACK_PATH}?${qs}`));
  }

  it("code is optional: a valid-state install with no code still completes (no token exchange)", async () => {
    // With "user authorization during installation" off, the install redirect
    // carries installation_id + setup_action + state but no code. The callback
    // must still record the install and redirect, not 400.
    // withSystemDb order (no code): conn lookup, UPDATE, org slug, ws slug.
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "uuid-conn-1" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-org" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-ws" }]) as TxLike),
      );

    const res = await makeCallbackReq({
      state: buildValidState(),
      installation_id: "142003699",
      setup_action: "install",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/knowledge/sources");
    // No code → no token exchange / encryption.
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("returns 400 when state is missing and there are no install params", async () => {
    const res = await makeCallbackReq({ code: "test-code" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Missing");
  });

  it("redirects (not 400) for a GitHub-initiated install that has no signed state", async () => {
    // User installs the App straight from GitHub's app page → installation_id +
    // setup_action but no state. Must redirect into the app, not 400.
    const res = await makeCallbackReq({
      installation_id: "142003699",
      setup_action: "install",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/?github_installed=1`);
    // The registry is platform-scoped, so the install is recorded without a
    // tenant. Asserting the redirect alone would pass with the write deleted.
    expect(vi.mocked(upsertGithubInstallation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertGithubInstallation)).toHaveBeenCalledWith({
      installationId: "142003699",
      reactivate: true,
    });
  });

  it("still redirects a no-state install when the registry write fails (negative)", async () => {
    vi.mocked(upsertGithubInstallation).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    const res = await makeCallbackReq({
      installation_id: "142003699",
      setup_action: "install",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_URL}/?github_installed=1`);
    expect(vi.mocked(upsertGithubInstallation)).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when GitHub App env vars are missing", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_CLIENT_ID: undefined,
    });
    const res = await makeCallbackReq({
      code: "code",
      state: buildValidState(),
    });
    expect(res.status).toBe(503);
  });

  it("returns 400 when state format is invalid (no dot separator)", async () => {
    const res = await makeCallbackReq({
      code: "code",
      state: "nodotseparator",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid state format");
  });

  // Named for what it exercises, not for what it looks like it exercises: the
  // non-base64url characters are simply dropped by `Buffer.from(x,
  // "base64url")`, which never throws, so the decode succeeds and the request
  // is refused one step later on the HMAC. That makes `verifyInstallState`'s
  // `invalid_encoding` branch unreachable in Node; it is retained because
  // removing it would change behaviour on a runtime whose base64url decoder
  // does throw, and it was equally unreachable before the refactor that moved
  // the check into @oxagen/github (behaviour-preserving port).
  it("returns 400 for a state whose body is not base64url (refused on the signature)", async () => {
    const res = await makeCallbackReq({
      code: "code",
      state: "!!!invalid_base64!!!.abc123",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid state signature");
  });

  it("returns 400 when a correctly-signed state decodes to something that is not JSON", async () => {
    // The `invalid_json` branch is reachable only with a VALID HMAC over a
    // non-JSON body — a state minted against a different payload shape, or a
    // stored secret reused across an encoding change. Same HMAC construction
    // as buildValidState(), over a body JSON.parse cannot read.
    const notJson = "this-is-not-json";
    const hmac = createHmac("sha256", STATE_SECRET)
      .update(notJson)
      .digest("hex");
    const state = `${Buffer.from(notJson).toString("base64url")}.${hmac}`;

    const res = await makeCallbackReq({ code: "code", state });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid state JSON");
  });

  it("returns 400 when state HMAC does not match", async () => {
    const validState = buildValidState();
    const dotIdx = validState.lastIndexOf(".");
    const tampered = `${validState.slice(0, dotIdx)}.deadbeefdeadbeef`;
    const res = await makeCallbackReq({ code: "code", state: tampered });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("signature");
  });

  it("returns 400 when state is expired", async () => {
    const expiredState = buildValidState({ expiresAt: Date.now() - 1000 });
    const res = await makeCallbackReq({ code: "code", state: expiredState });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("expired");
  });

  it("returns 502 when GitHub token exchange API returns non-200", async () => {
    // Connection lookup runs first now, so it must find the row for the flow to
    // reach token exchange.
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ id: "uuid-conn-1" }]) as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const res = await makeCallbackReq({
      code: "code",
      state: buildValidState(),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("503");
  });

  it("returns 400 when GitHub token exchange returns error field", async () => {
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ id: "uuid-conn-1" }]) as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        error: "bad_verification_code",
        error_description: "Code already used",
      }),
    });

    const res = await makeCallbackReq({
      code: "code",
      state: buildValidState(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Code already used");
  });

  it("happy path: exchanges code, stores tokens, and redirects to app", async () => {
    // Token exchange
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_abc123",
          refresh_token: "ghr_xyz789",
          expires_in: 28800,
          token_type: "Bearer",
          scope: "repo,read:org",
        }),
      })
      // GitHub user info fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 12345,
          login: "testuser",
          email: "test@test.com",
          name: "Test User",
        }),
      });

    // DB: source_connection found
    const connRow = {
      id: "uuid-conn-1",
      orgId: "org-id-test",
      workspaceId: "ws-id-test",
    };
    // oauthAccounts insert
    const oauthRow = { id: "uuid-oauth-1" };
    // orgs slug
    const orgSlugRow = { slug: "my-org" };
    // workspaces slug
    const wsSlugRow = { slug: "my-ws" };

    // withSystemDb calls in order: source_connections lookup, oauth upsert, oauth update, org slug, ws slug
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([connRow]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([oauthRow]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([]) as TxLike),
      ) // UPDATE source_connections
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([orgSlugRow]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([wsSlugRow]) as TxLike),
      );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState(),
    });

    // Should redirect (302)
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/knowledge/sources");
    expect(location).toContain("setup=github");
    expect(location).toContain("connectionId=con_ABC");

    // encrypt should have been called twice: once for access_token, once for refresh_token
    expect(mocks.encrypt).toHaveBeenCalledTimes(2);
  });

  it("returns 404 when source_connection is not found", async () => {
    // Connection lookup runs FIRST now, so an empty result 404s before any token
    // exchange — no fetch should occur.
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([]) as TxLike),
    );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState(),
    });
    expect(res.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("settings connect (null connectionId): stores the org token and redirects to the workspace landing with the dialog params", async () => {
    // 555 is in the authorizing user's /user/installations, so the attach
    // stands and the redirect may say so.
    queueVerifiedInstallFetches([555]);

    // No connection lookup up front (connectionId is null). withSystemDb order:
    // oauth upsert, the settings-level install attach, org slug, ws slug.
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "oauth-settings" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-org" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-ws" }]) as TxLike),
      );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "555",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    // NOT /{org}/{ws}/settings/github: apps/app has no such route, and the 308
    // that legacy-routes.ts answers with drops the query string — a completed
    // install used to land on Fleet with no acknowledgement. The landing route
    // carries the params the Workspace settings dialog opens on.
    expect(location).toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=connected`,
    );
    expect(location).not.toContain("settings/github");
    expect(location).not.toContain("connectionId");
    // Token was stored even though no connection was attached.
    expect(mocks.encrypt).toHaveBeenCalled();
  });

  it("merges the installation_id into deliveryConfig without clobbering existing keys", async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_x",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 99, login: "u" }),
      })
      // The wizard leg verifies its installation_id against
      // /user/installations too, and 142003699 is one this user reaches.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 1,
          installations: [
            {
              id: 142003699,
              account: { login: "acme", type: "Organization", avatar_url: "" },
              repository_selection: "all",
              app_slug: APP_SLUG,
            },
          ],
        }),
      });

    // Capture the UPDATE .set() payload to assert the merge.
    let updateSetArg: Record<string, unknown> | undefined;
    const updateChain = {
      set: vi.fn((arg: Record<string, unknown>) => {
        updateSetArg = arg;
        return updateChain;
      }),
      where: vi.fn().mockResolvedValue(undefined),
    };
    const updateTx = {
      ...makeTxChain([]),
      update: vi.fn().mockReturnValue(updateChain),
    };

    // Order: conn lookup (has existing config), oauth upsert, UPDATE (captured), org slug, ws slug.
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(
          makeTxChain([
            { id: "uuid-conn-1", deliveryConfig: { syncDepthDays: 90 } },
          ]) as TxLike,
        ),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "oauth-1" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(updateTx as unknown as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "o" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "w" }]) as TxLike),
      );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState(),
      installation_id: "142003699",
      setup_action: "install",
    });
    expect(res.status).toBe(302);
    expect(updateSetArg?.deliveryConfig).toEqual({
      syncDepthDays: 90,
      installationId: "142003699",
    });
    expect(updateSetArg?.oauthAccountId).toBe("oauth-1");
  });

  // ── settings-level install → the workspace's GitHub source connection ──────
  //
  // `get_main_repository`, `link_repository` and
  // `list_installation_repositories` all read the workspace's installation out
  // of `ingestion.source_connections`. Before these, a settings-level install
  // wrote only the platform catalog (`ingestion.github_installations`), which
  // none of them read — so the dialog that sent the operator to GitHub still
  // reported `connected: false` when they came back, and the feature was a dead
  // loop.

  /**
   * The GitHub calls a VERIFIED settings install makes, in order: the token
   * exchange, the `/user` lookup, and the `/user/installations` page the attach
   * checks the redirect's `installation_id` against.
   *
   * `reachable` is the set of installation ids that user can actually reach.
   * Every settings-level attach now depends on this list, because
   * `installation_id` is a query parameter on a public endpoint and the state
   * HMAC says nothing about it.
   */
  function queueVerifiedInstallFetches(reachable: readonly number[]) {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_settings",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: reachable.length,
          installations: reachable.map((id) => ({
            id,
            account: { login: "acme", type: "Organization", avatar_url: "" },
            repository_selection: "all",
            app_slug: APP_SLUG,
          })),
        }),
      });
  }

  /** Queue the oauth_accounts upsert that a leg carrying a `code` runs first. */
  function queueOauthUpsert(id = "uuid-oauth-settings") {
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ id }]) as TxLike),
    );
  }

  /** Queue the redirect's two slug lookups, which close every callback leg. */
  function queueSlugLookups() {
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-org" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ slug: "my-ws" }]) as TxLike),
      );
  }

  /**
   * Queue the withSystemDb sequence that FOLLOWS the oauth upsert on a settings
   * install: the attach itself, then the two slug lookups. Callers that carry a
   * `code` queue `queueOauthUpsert()` ahead of this — and every attaching leg
   * now does, because without a user token there is nothing to verify the
   * `installation_id` against and the attach refuses.
   */
  function queueSettingsAttach(attachTx: TxLike) {
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(attachTx),
    );
    queueSlugLookups();
  }

  it("settings install: CREATES the workspace github connection carrying the installationId", async () => {
    queueVerifiedInstallFetches([142003699]);
    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSettingsAttach(tx);

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "142003699",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    // This is the row resolveWorkspaceGithubInstallation reads.
    expect(captured.insertValues).toMatchObject({
      orgId: "org-id-test",
      workspaceId: "ws-id-test",
      connectorId: "github",
      deliveryConfig: { installationId: "142003699" },
    });
    // pending_setup, not connected: the install exists but nothing is bound
    // through it, and `connected` is what the ingestion poll scheduler claims.
    expect(captured.insertValues?.["status"]).toBe("pending_setup");
    // No acting user on a public OAuth redirect — an honest absence, not a
    // fabricated id (ADR-077 attribution columns are nullable).
    expect(captured.insertValues?.["createdById"]).toBeUndefined();
    expect(captured.updateSet).toBeUndefined();
  });

  it("settings install: UPDATES an existing github connection, merging installationId and preserving other deliveryConfig keys", async () => {
    queueVerifiedInstallFetches([555]);
    const { tx, captured } = makeCapturingTx([
      {
        id: "uuid-existing-gh",
        deliveryConfig: { syncDepthDays: 90, owner: "acme", repo: "widgets" },
      },
    ]);
    queueOauthUpsert();
    queueSettingsAttach(tx);

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "555",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(captured.updateSet?.["deliveryConfig"]).toEqual({
      syncDepthDays: 90,
      owner: "acme",
      repo: "widgets",
      installationId: "555",
    });
    // Status untouched: a workspace that already bound a repository is
    // `connected`, and re-installing the App is no reason to demote it.
    expect(captured.updateSet).not.toHaveProperty("status");
    expect(captured.insertValues).toBeUndefined();
  });

  it("settings install: links the oauth_account onto the connection when a code was exchanged", async () => {
    queueVerifiedInstallFetches([777]);

    const { tx, captured } = makeCapturingTx([]);
    // With a code, the oauth upsert runs first.
    queueOauthUpsert();
    queueSettingsAttach(tx);

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "777",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(captured.insertValues?.["oauthAccountId"]).toBe(
      "uuid-oauth-settings",
    );
  });

  it("settings install: the connection lookup is scoped by BOTH the state's orgId and workspaceId", async () => {
    queueVerifiedInstallFetches([142003699]);
    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSettingsAttach(tx);

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({
        orgId: "org-mine",
        workspaceId: "ws-mine",
        connectionId: null,
        returnTo: "settings",
      }),
      installation_id: "142003699",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    const params = boundParams(captured.selectWhere);
    // Both ids from the signed state, plus the connector — so another
    // workspace's (or another org's) github connection is never the row this
    // writes to.
    expect(params).toContain("org-mine");
    expect(params).toContain("ws-mine");
    expect(params).toContain("github");
  });

  it("settings install: a malformed installation_id is not written at all", async () => {
    // The repository resolver only accepts a plain positive integer, so writing
    // anything else would leave a connection every reader silently skips — a
    // connection that looks attached and is not. Only the two slug lookups run.
    queueSlugLookups();

    const res = await makeCallbackReq({
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "not-a-number",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    // Refused, so the redirect says so. It used to say `github=connected` here
    // — announcing an attach that never happened, to a dialog whose very next
    // read answers `connected: false`.
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=failed`,
    );
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
  });

  it("settings install with no installation_id at all touches no connection", async () => {
    // The identity-only leg (OAuth without an install) has nothing to attach,
    // so only the two slug lookups run.
    queueSlugLookups();

    const res = await makeCallbackReq({
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
    });

    expect(res.status).toBe(302);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
    // Nothing was claimed and nothing was attached, so there is nothing to
    // acknowledge — neither a success nor a failure.
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository`,
    );
    expect(location).not.toContain("github=");
  });

  // ── the identity leg: a code, and never an installation_id ────────────────
  //
  // The dialog's Connect action opens `login/oauth/authorize`, because
  // `installations/new` only round-trips a code and our signed state on the
  // FIRST install of the App on an account — with it, a reconnect and a second
  // workspace connecting to an already-installed account both dead-ended at the
  // callback's no-state branch. The identity URL fixed that and brought its own
  // gap: it ALWAYS returns a code and NEVER an installation_id. So a first-time
  // user authorized, came back with a token stored, `github.connected` still
  // false, and one button that would do the same thing again.
  //
  // What the callback holds after that exchange is authority to ask GitHub what
  // this person reaches. These are the three answers.

  /**
   * The GitHub calls an identity-leg connect makes: the token exchange, the
   * `/user` lookup, and the `/user/installations` page this leg now reads to
   * find out what the authorizing user reaches.
   */
  function queueIdentityFetches(reachable: readonly number[]) {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_identity",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: reachable.length,
          installations: reachable.map((id) => ({
            id,
            account: { login: "acme", type: "Organization", avatar_url: "" },
            repository_selection: "all",
            app_slug: APP_SLUG,
          })),
        }),
      });
  }

  /** The identity-leg request itself: a code, a settings state, no installation_id. */
  function identityCallback() {
    return makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
    });
  }

  it("identity leg with ONE reachable installation attaches it and lands on the picker", async () => {
    // The first-time case this whole change exists for. The attach still goes
    // through the same verification gate, which asks /user/installations a
    // second time — one gate taken by every path beats a gate with an exemption.
    queueIdentityFetches([424242]);
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        installations: [{ id: 424242, account: { login: "acme" } }],
      }),
    });
    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSettingsAttach(tx);

    const res = await identityCallback();

    expect(res.status).toBe(302);
    expect(captured.insertValues).toMatchObject({
      deliveryConfig: { installationId: "424242" },
    });
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=connected`,
    );
  });

  it("identity leg with SEVERAL reachable installations attaches none and asks", async () => {
    // Which account a workspace acts through is a choice with consequences —
    // the repository capabilities mint tokens with the platform App's key
    // against whatever is attached — so the platform does not guess it.
    queueIdentityFetches([111, 222]);
    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    // No attach tx is queued: if the route writes anything it consumes the slug
    // lookups' chain and the location assertion below fails.
    queueSlugLookups();

    const res = await identityCallback();

    expect(res.status).toBe(302);
    expect(captured.insertValues).toBeUndefined();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=choose`,
    );
  });

  it("identity leg with NO reachable installation points at the install door", async () => {
    // Authorizing again would loop forever: the App is installed on no account
    // this person administers, so the next click is installations/new.
    queueIdentityFetches([]);
    const { tx } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSlugLookups();

    const res = await identityCallback();

    expect(res.status).toBe(302);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=install`,
    );
  });

  it("identity leg attaches nothing when the verification gate refuses the one it found", async () => {
    // Belt and braces: the id came from the user's own list, so this cannot
    // normally happen — and if the second ask disagrees, the answer is still no.
    queueIdentityFetches([424242]);
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ total_count: 0, installations: [] }),
    });
    const { tx } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSlugLookups();

    const res = await identityCallback();

    expect(tx.insert).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=failed`,
    );
  });

  it("identity leg says nothing at all when GitHub would not answer (negative)", async () => {
    // Nothing was claimed, so there is nothing to decline. The dialog re-reads
    // its own state on arrival and draws both doors.
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "ghs_identity" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({}),
      });
    const { tx } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSlugLookups();

    const res = await identityCallback();

    expect(tx.insert).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository`,
    );
    expect(location).not.toContain("github=");
  });

  it("identity leg survives a listing that threw, attaching nothing (negative)", async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "ghs_identity" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      })
      .mockRejectedValueOnce(new Error("network"));
    const { tx } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSlugLookups();

    const res = await identityCallback();

    expect(res.status).toBe(302);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository`,
    );
  });

  // The legacy wizard leg is untouched by this: it carries a connectionId, so
  // it never reaches the identity branch, whatever GitHub lists.
  it("the legacy wizard leg never lists installations of its own (negative)", async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "ghs_wizard" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      });
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "uuid-conn-1" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "uuid-oauth-1" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([]) as TxLike),
      );
    queueSlugLookups();

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/knowledge/sources");
    // Exactly two GitHub calls: the exchange and the /user lookup. No listing.
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  // ── the installation_id is a claim, and the claim is checked ───────────────
  //
  // `installation_id` is a query parameter on a PUBLIC endpoint. The state HMAC
  // proves which org+workspace started the flow and nothing whatever about the
  // id, and `code` is optional on this leg — so an operator who legitimately
  // administers their own workspace can mint a valid state for it, skip GitHub
  // entirely, and call this callback with any numeric id they like, including
  // one belonging to another tenant.
  //
  // That was survivable while every consumer called GitHub with the USER token
  // (`GET /user/installations/:id/repositories`), because GitHub scoped the
  // request to that user itself. It is not survivable now:
  // `list_installation_repositories` and `link_repository` mint a token
  // with the platform App's PRIVATE KEY, which checks no caller entitlement at
  // all. GitHub's own check is gone, so an unverified id is another tenant's
  // repositories listed and linkable. These are the tests that keep the check.

  it("settings install: an installation_id the authorizing user cannot reach is NEVER written", async () => {
    // The forgery, exactly: a valid state for the attacker's OWN workspace, a
    // real OAuth code, and a numeric installation id belonging to someone else.
    // /user/installations is the authority, and it does not list 999999.
    queueVerifiedInstallFetches([555]);
    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    // No attach tx is queued on purpose: if the route writes anything, it
    // consumes the slug lookup's chain and the location assertion below fails.
    queueSlugLookups();

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "999999",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    // Nothing written: no INSERT, no UPDATE, and no connection lookup at all.
    expect(captured.insertValues).toBeUndefined();
    expect(captured.updateSet).toBeUndefined();
    expect(captured.selectWhere).toBeUndefined();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    // And the redirect does not claim a connection.
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=failed`,
    );
    expect(location).not.toContain("github=connected");
  });

  it("settings install: an installation_id the user CAN reach is written, and only then", async () => {
    // The mirror of the test above, so the check is not merely proven to refuse
    // everything: the same request, differing only in whether GitHub lists the
    // id, attaches.
    //
    // This is also the first-ever install's happy path (#3254): the signed
    // install door round-trips `code` + state + `installation_id`, so the
    // callback verifies the claim and attaches in one hop, and the person lands
    // on the dialog connected rather than on the app root.
    queueVerifiedInstallFetches([999999]);
    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSettingsAttach(tx);

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "999999",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(captured.insertValues).toMatchObject({
      deliveryConfig: { installationId: "999999" },
    });
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=connected`,
    );
    // Not the no-state branch's destination: state was carried, so the
    // callback knew which workspace asked.
    expect(location).not.toContain("github_installed");
  });

  it("settings install: verification reads /user/installations with the just-exchanged user token", async () => {
    queueVerifiedInstallFetches([555]);
    const { tx } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSettingsAttach(tx);

    await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "555",
      setup_action: "install",
    });

    // Third call: token exchange, /user, then the verification.
    const [url, init] = mocks.fetch.mock.calls[2] as [string, RequestInit];
    expect(url).toContain("https://api.github.com/user/installations");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer ghs_settings",
    );
  });

  it("settings install: an installation_id with NO code to verify it against attaches nothing", async () => {
    // Without a `code` there is no user token, so nothing can testify that this
    // person reaches this installation. An unverifiable claim is not a weaker
    // claim — it is the exact shape the forgery takes, since `code` is optional
    // on this leg and the attacker simply omits it.
    //
    // Whether a `code` comes back is the App's "request user authorization
    // (OAuth) during installation" setting, which is external configuration
    // this codebase cannot flip — so this is an ordinary outcome for an honest
    // first-ever install, not only an attack shape. It is acknowledged apart
    // from `failed` for that reason and ONLY for that reason: the person did
    // nothing wrong and one identity round trip finishes the job, whereas
    // `failed` means installing again on the right account. Nothing is attached
    // either way, which is the part that must never move (#3254).
    queueSlugLookups();

    const res = await makeCallbackReq({
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "555",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    // Only the two slug lookups — no attach.
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(2);
    // And no GitHub call was made either: there was no token to make one with.
    expect(mocks.fetch).not.toHaveBeenCalled();
    const location = res.headers.get("location") ?? "";
    // Back on the dialog, told which click finishes it — never the app root
    // the unsigned install door used to strand people on.
    expect(location).toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=authorize`,
    );
    expect(location).not.toContain("github=connected");
    expect(location).not.toContain("github_installed");
  });

  it("settings install: a /user/installations that errors refuses rather than attaching", async () => {
    // Fail closed. A verification that could not run is not a verification that
    // passed — and a 500 here would be a worse answer still, since the operator
    // would see a bare JSON error instead of the dialog.
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_settings",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      });

    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSlugLookups();

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "555",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(captured.insertValues).toBeUndefined();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=failed`,
    );
  });

  it("settings install: a /user/installations that throws refuses rather than 500ing the callback", async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_settings",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 7, login: "owner" }),
      })
      .mockRejectedValueOnce(new Error("TimeoutError"));

    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSlugLookups();

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "555",
      setup_action: "install",
    });

    // Not a 500 and not a JSON error page: the operator lands back on the
    // dialog, which reports not-connected honestly.
    expect(res.status).toBe(302);
    expect(captured.insertValues).toBeUndefined();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(res.headers.get("location") ?? "").toBe(
      `${APP_URL}/my-org/my-ws/repositories?settings=repository&github=failed`,
    );
  });

  // ── the legacy wizard leg is checked too ──────────────────────────────────
  //
  // This leg used to be exempt, on the reasoning that everything downstream of
  // it called GitHub with the USER token, which GitHub scopes to that user
  // itself. That reasoning expired with #2967:
  // `resolveWorkspaceGithubInstallation` hands ANY github connection row
  // carrying an installationId — legacy wizard rows included — to
  // `list_installation_repositories` and `link_repository`, and those mint
  // a token with the platform App's PRIVATE KEY, which checks no caller
  // entitlement. So a wizard-written id is an id the App acts through, and the
  // exemption was the same hole by another door.

  /**
   * The withSystemDb sequence a legacy-leg callback runs: the connection
   * lookup, the oauth upsert, the UPDATE (captured here), then the two slug
   * lookups.
   */
  function queueLegacyLeg(deliveryConfig: Record<string, unknown> = {}) {
    let updateSetArg: Record<string, unknown> | undefined;
    const updateChain = {
      set: vi.fn((arg: Record<string, unknown>) => {
        updateSetArg = arg;
        return updateChain;
      }),
      where: vi.fn().mockResolvedValue(undefined),
    };
    const updateTx = {
      ...makeTxChain([]),
      update: vi.fn().mockReturnValue(updateChain),
    };

    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "uuid-conn-legacy", deliveryConfig }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(makeTxChain([{ id: "oauth-legacy" }]) as TxLike),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(updateTx as unknown as TxLike),
      );
    queueSlugLookups();

    return {
      get updateSet() {
        return updateSetArg;
      },
    };
  }

  it("legacy wizard: an installation_id the authorizing user cannot reach is NEVER written", async () => {
    // The same forgery the settings leg refuses, through the wizard door: a
    // valid state for the attacker's OWN connection, a real OAuth code, and a
    // numeric installation id belonging to someone else. /user/installations is
    // the authority, and it does not list 999999.
    //
    // This assertion is the inverse of the one that used to stand here, which
    // proved 999999 WAS written — the vulnerability, encoded as a test.
    queueVerifiedInstallFetches([555]);
    const captured = queueLegacyLeg();

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: "con_ABC" }),
      installation_id: "999999",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    // The unproven fact is dropped: deliveryConfig is not touched at all.
    expect(captured.updateSet).not.toHaveProperty("deliveryConfig");
    // And the check really ran, against the user's own list.
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.fetch.mock.calls[2]?.[0]).toContain(
      "https://api.github.com/user/installations",
    );
  });

  it("legacy wizard: a refused installation_id keeps the oauth link and the status reset", async () => {
    // A refusal is bounded to the id. `oauthAccountId` names a token GitHub
    // itself minted in exchange for a code GitHub issued, and the status reset
    // follows from the HMAC-verified state — neither is the redirect's claim.
    // Refusing the whole update would strip a legitimately exchanged token and
    // dead-end an honest user at "OAuth token not found for connection".
    queueVerifiedInstallFetches([555]);
    const captured = queueLegacyLeg({ syncDepthDays: 90 });

    await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: "con_ABC" }),
      installation_id: "999999",
      setup_action: "install",
    });

    expect(captured.updateSet?.["oauthAccountId"]).toBe("oauth-legacy");
    expect(captured.updateSet?.["status"]).toBe("pending_setup");
    expect(captured.updateSet).not.toHaveProperty("deliveryConfig");
  });

  it("legacy wizard: an installation_id the user CAN reach is written, and only then", async () => {
    // The mirror, so the check is not merely proven to refuse everything: the
    // same request, differing only in whether GitHub lists the id, attaches —
    // and still merges rather than clobbering the wizard's existing keys.
    queueVerifiedInstallFetches([999999]);
    const captured = queueLegacyLeg({ syncDepthDays: 90 });

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: "con_ABC" }),
      installation_id: "999999",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(captured.updateSet?.["deliveryConfig"]).toEqual({
      syncDepthDays: 90,
      installationId: "999999",
    });
  });

  it("legacy wizard: an installation_id with NO code to verify it against is refused", async () => {
    // `code` is optional on this leg, so omitting it is exactly how the forgery
    // is cheapest: no user token means nothing can testify that this person
    // reaches this installation, and an unverifiable claim is no claim.
    // Without a code there is no oauth upsert, so the sequence is one shorter.
    let updateSetArg: Record<string, unknown> | undefined;
    const updateChain = {
      set: vi.fn((arg: Record<string, unknown>) => {
        updateSetArg = arg;
        return updateChain;
      }),
      where: vi.fn().mockResolvedValue(undefined),
    };
    const updateTx = {
      ...makeTxChain([]),
      update: vi.fn().mockReturnValue(updateChain),
    };
    mocks.withSystemDb
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(
          makeTxChain([
            { id: "uuid-conn-legacy", deliveryConfig: {} },
          ]) as TxLike,
        ),
      )
      .mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
        fn(updateTx as unknown as TxLike),
      );
    queueSlugLookups();

    const res = await makeCallbackReq({
      state: buildValidState({ connectionId: "con_ABC" }),
      installation_id: "555",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(updateSetArg).not.toHaveProperty("deliveryConfig");
    // No GitHub call at all: there was no token to make one with.
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("legacy wizard: a malformed installation_id is not written", async () => {
    // Same pre-filter as the settings leg: `installationIdOf` only accepts a
    // plain positive integer, so anything else would leave a connection that
    // looks attached and that every reader silently skips. Only two fetches are
    // queued, because the syntax guard refuses before the round trip is spent.
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "ghs_legacy",
          token_type: "Bearer",
          scope: "repo",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 11, login: "legacy" }),
      });
    const captured = queueLegacyLeg();

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: "con_ABC" }),
      installation_id: "not-a-number",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(captured.updateSet).not.toHaveProperty("deliveryConfig");
    // Refused on syntax alone — the round trip to GitHub is never spent.
    for (const [url] of mocks.fetch.mock.calls as [string, unknown][]) {
      expect(url).not.toContain("/user/installations");
    }
  });

  // ── which write path the state picks, and what happens in between ─────────
  //
  // The callback dispatches on the RESOLVED CONNECTION, not on `returnTo`:
  // `conn` non-null takes the legacy wizard write against that connection,
  // `conn` null takes the settings write against the workspace's authoritative
  // GitHub connection. There is a third case between them — a state that NAMED
  // a connection which does not resolve in its own org+workspace — and it must
  // be neither, because downgrading it to the settings path would hand a bogus
  // connectionId the MORE powerful of the two writes.

  it("refuses a state naming a connection that does not resolve, and attaches nothing", async () => {
    // The lookup answers no row: wrong publicId, another workspace's
    // connection, or one already soft-deleted. The leg stops at the lookup.
    const update = vi.fn();
    mocks.withSystemDb.mockImplementation((fn: Parameters<DbFn>[0]) =>
      fn({ ...makeTxChain([]), update } as unknown as TxLike),
    );

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: "con_GHOST" }),
      installation_id: "999999",
      setup_action: "install",
    });

    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Connection not found",
    );
    // Nothing written, and the `code` never even exchanged — so no settings
    // connection was created and no oauth account linked.
    expect(update).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("still takes the settings write path for a state that legitimately names no connection", async () => {
    // The mirror of the refusal above, so it is not merely proven that the
    // callback refuses everything: the same request differing only in that the
    // state names NO connection creates the workspace's github connection.
    queueVerifiedInstallFetches([999999]);
    const { tx, captured } = makeCapturingTx([]);
    queueOauthUpsert();
    queueSettingsAttach(tx);

    const res = await makeCallbackReq({
      code: "auth-code",
      state: buildValidState({ connectionId: null, returnTo: "settings" }),
      installation_id: "999999",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(captured.insertValues).toMatchObject({
      connectorId: "github",
      deliveryConfig: { installationId: "999999" },
    });
  });
});

// ── GET /connections/github/installations ─────────────────────────────────────

describe("GET /connections/github/installations", () => {
  it("WITHOUT a connectionId, resolves the workspace token (404 when the org has no GitHub OAuth account)", async () => {
    // Settings + post-install sources picker omit connectionId; the resolver
    // falls back to the org's GitHub OAuth account, which is absent here.
    const res = await authGet(`${BASE}/installations`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not connected");
  });

  it("WITHOUT a connectionId, lists installations using the workspace's org GitHub token", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          {
            id: "oa1",
            accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" },
          },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        installations: [
          {
            id: 333,
            account: {
              login: "ws-org",
              type: "Organization",
              avatar_url: "https://gh.com/333",
            },
            repository_selection: "all",
          },
        ],
      }),
    });

    const res = await authGet(`${BASE}/installations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installations: Array<{ accountLogin: string }>;
    };
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]!.accountLogin).toBe("ws-org");
  });

  it("returns 404 when connection is not found in DB", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([]) as TxLike),
    );
    const res = await authGet(`${BASE}/installations?connectionId=con_MISSING`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when accessTokenEnc is null", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: null }]) as TxLike),
    );
    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("token not found");
  });

  it("returns 502 when GitHub API fails", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("401");
  });

  it("returns installations list on happy path", async () => {
    // Unset GITHUB_APP_SLUG so manageUrl derives from the installation's app_slug.
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );

    const ghResponse = {
      total_count: 2,
      installations: [
        {
          id: 111,
          account: {
            login: "acme-org",
            type: "Organization",
            avatar_url: "https://avatars.gh.com/111",
          },
          repository_selection: "all",
          html_url:
            "https://github.com/organizations/acme-org/settings/installations/111",
          app_slug: "oxagen",
        },
        {
          id: 222,
          account: {
            login: "bob",
            type: "User",
            avatar_url: "https://avatars.gh.com/222",
          },
          repository_selection: "selected",
        },
      ],
    };
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ghResponse,
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      installations: Array<{
        id: number;
        accountLogin: string;
        accountType: string;
        repositorySelection: string;
        avatarUrl: string;
        htmlUrl: string | null;
      }>;
      manageUrl: string;
    };
    expect(body.installations).toHaveLength(2);
    expect(body.installations[0]!.accountLogin).toBe("acme-org");
    expect(body.installations[0]!.accountType).toBe("Organization");
    expect(body.installations[0]!.repositorySelection).toBe("all");
    // Per-installation management page is mapped through; null when GitHub omits it.
    expect(body.installations[0]!.htmlUrl).toBe(
      "https://github.com/organizations/acme-org/settings/installations/111",
    );
    expect(body.installations[1]!.id).toBe(222);
    expect(body.installations[1]!.htmlUrl).toBeNull();
    // manageUrl derives from the installation's app_slug when GITHUB_APP_SLUG is unset.
    expect(body.manageUrl).toBe(
      "https://github.com/apps/oxagen/installations/new",
    );
  });

  it("manageUrl uses GITHUB_APP_SLUG when configured", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: "oxagen-prod",
    });
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        total_count: 1,
        installations: [
          {
            id: 111,
            account: {
              login: "acme-org",
              type: "Organization",
              avatar_url: "https://gh.com",
            },
            repository_selection: "all",
            app_slug: "from-installation",
          },
        ],
      }),
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manageUrl: string };
    // Configured slug wins over the installation-derived slug.
    expect(body.manageUrl).toBe(
      "https://github.com/apps/oxagen-prod/installations/new",
    );
  });

  it("manageUrl falls back to GitHub settings when no slug is available", async () => {
    mocks.requireEnv.mockReturnValue({
      ...DEFAULT_ENV,
      GITHUB_APP_SLUG: undefined,
    });
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    // Zero installations and no GITHUB_APP_SLUG → generic settings page.
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ total_count: 0, installations: [] }),
    });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manageUrl: string;
      installations: unknown[];
    };
    expect(body.installations).toHaveLength(0);
    expect(body.manageUrl).toBe("https://github.com/settings/installations");
  });

  it("paginates when total_count exceeds 100", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );

    // Page 1: 100 installations
    const page1Installations = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      account: {
        login: `org-${i + 1}`,
        type: "Organization",
        avatar_url: "https://gh.com",
      },
      repository_selection: "all",
    }));
    // Page 2: 1 installation
    const page2Installations = [
      {
        id: 101,
        account: {
          login: "org-101",
          type: "Organization",
          avatar_url: "https://gh.com",
        },
        repository_selection: "all",
      },
    ];

    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 101,
          installations: page1Installations,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          total_count: 101,
          installations: page2Installations,
        }),
      });

    const res = await authGet(`${BASE}/installations?connectionId=con_ABC`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: unknown[] };
    expect(body.installations).toHaveLength(101);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});

// ── GET /connections/github/installations/:id/repositories ────────────────────

describe("GET /connections/github/installations/:id/repositories", () => {
  const INSTALL_ID = "12345";
  const PATH = `${BASE}/installations/${INSTALL_ID}/repositories`;

  it("WITHOUT a connectionId, resolves the workspace token (404 when the org has no GitHub OAuth account)", async () => {
    // connectionId is now optional here too — the post-install sources picker
    // lists repos using the workspace's org-level token.
    const res = await authGet(PATH);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not connected");
  });

  it("returns 404 when connection is not found", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([]) as TxLike),
    );
    const res = await authGet(`${PATH}?connectionId=con_MISSING`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when accessTokenEnc is null", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(makeTxChain([{ accessTokenEnc: null }]) as TxLike),
    );
    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(404);
  });

  it("returns 502 when GitHub API fails", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({}),
    });

    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("403");
  });

  it("returns repositories with correct shape on happy path", async () => {
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(
        makeTxChain([
          { accessTokenEnc: { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" } },
        ]) as TxLike,
      ),
    );

    const ghResponse = {
      total_count: 2,
      repositories: [
        {
          id: 9001,
          name: "my-api",
          full_name: "acme-org/my-api",
          private: false,
          default_branch: "main",
          language: "TypeScript",
          description: "The main API",
        },
        {
          id: 9002,
          name: "internal-tools",
          full_name: "acme-org/internal-tools",
          private: true,
          default_branch: "main",
          language: null,
          description: null,
        },
      ],
    };
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ghResponse,
    });

    const res = await authGet(`${PATH}?connectionId=con_ABC`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      repositories: Array<{
        id: number;
        name: string;
        fullName: string;
        private: boolean;
        defaultBranch: string;
        language: string | null;
        description: string | null;
      }>;
      totalCount: number;
    };

    expect(body.totalCount).toBe(2);
    expect(body.repositories).toHaveLength(2);
    expect(body.repositories[0]!.fullName).toBe("acme-org/my-api");
    expect(body.repositories[0]!.language).toBe("TypeScript");
    expect(body.repositories[1]!.private).toBe(true);
    expect(body.repositories[1]!.language).toBeNull();

    // Verify the request was made to the correct GitHub endpoint
    const fetchCall = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(fetchCall[0]).toContain(
      `/user/installations/${INSTALL_ID}/repositories`,
    );
    expect(fetchCall[1]?.headers).toMatchObject({
      Authorization: "Bearer decrypted-access-token",
    });
  });
});

// ── OAuth token resolution (Setup-URL "update" leg) ───────────────────────────
//
// When the GitHub App is ALREADY installed, GitHub completes the connect through
// the stateless Setup URL leg, which never hits our OAuth callback — so the
// freshly-created connection has a null oauthAccountId. The endpoints must fall
// back to the org's existing GitHub OAuth account (and link it) rather than 404,
// which is what dead-ended the wizard at "list installations".

describe("OAuth token resolution for /installations", () => {
  const ENC = { keyId: "k1", ciphertext: "Y2lwaGVydGV4dA==" };

  /**
   * A tx whose successive .select()…​.limit() calls resolve successive queued
   * result sets, and whose .update().set() payload is captured. Supports the
   * .orderBy() used by the fallback query (the shared makeTxChain does not).
   */
  function makeSequencedTx(
    selectResults: unknown[][],
    onUpdateSet?: (arg: Record<string, unknown>) => void,
  ) {
    let call = 0;
    const makeSelectChain = () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.orderBy = vi.fn(() => chain);
      chain.limit = vi.fn(async () => selectResults[call++] ?? []);
      return chain;
    };
    const updateChain: Record<string, unknown> = {};
    updateChain.set = vi.fn((arg: Record<string, unknown>) => {
      onUpdateSet?.(arg);
      return updateChain;
    });
    updateChain.where = vi.fn().mockResolvedValue(undefined);
    return {
      select: vi.fn(() => makeSelectChain()),
      update: vi.fn(() => updateChain),
      insert: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
  }

  const GH_OK = {
    ok: true,
    status: 200,
    json: async () => ({
      total_count: 1,
      installations: [
        {
          id: 111,
          account: {
            login: "acme",
            type: "Organization",
            avatar_url: "https://gh.com",
          },
          repository_selection: "all",
        },
      ],
    }),
  };

  it("falls back to and links the org's GitHub OAuth account when the connection is unlinked", async () => {
    let updateArg: Record<string, unknown> | undefined;
    // Query order inside resolveConnectionAccessToken:
    //   1. source_connections → { id, oauthAccountId: null }  (unlinked)
    //   2. oauth_accounts fallback → { id, accessTokenEnc }    (the org's account)
    const seqTx = makeSequencedTx(
      [
        [{ id: "conn-uuid-1", oauthAccountId: null }],
        [{ id: "oa-org-1", accessTokenEnc: ENC }],
      ],
      (arg) => {
        updateArg = arg;
      },
    );
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(seqTx as unknown as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce(GH_OK);

    const res = await authGet(
      `${BASE}/installations?connectionId=con_UPDATE_LEG`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: unknown[] };
    expect(body.installations).toHaveLength(1);

    // The unlinked connection is now linked to the fallback account so the
    // activation path and later calls resolve it directly.
    expect(updateArg?.oauthAccountId).toBe("oa-org-1");
    // The fetch used the decrypted fallback token.
    const fetchCall = mocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(fetchCall[1]?.headers).toMatchObject({
      Authorization: "Bearer decrypted-access-token",
    });
  });

  it("uses the directly-linked OAuth account without a fallback when one is set", async () => {
    let updateCalled = false;
    // Query order: source_connections → { oauthAccountId set }, then
    // oauth_accounts BY ID → { accessTokenEnc }. No fallback select, no update.
    const seqTx = makeSequencedTx(
      [
        [{ id: "conn-uuid-2", oauthAccountId: "oa-linked-1" }],
        [{ accessTokenEnc: ENC }],
      ],
      () => {
        updateCalled = true;
      },
    );
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(seqTx as unknown as TxLike),
    );
    mocks.fetch.mockResolvedValueOnce(GH_OK);

    const res = await authGet(`${BASE}/installations?connectionId=con_LINKED`);
    expect(res.status).toBe(200);
    // A connection already linked must not be re-linked.
    expect(updateCalled).toBe(false);
  });

  it("returns 404 when neither the connection nor the org has any GitHub OAuth account", async () => {
    // source_connections → unlinked; fallback oauth_accounts → empty.
    const seqTx = makeSequencedTx([
      [{ id: "conn-uuid-3", oauthAccountId: null }],
      [],
    ]);
    mocks.withTenantDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(seqTx as unknown as TxLike),
    );

    const res = await authGet(`${BASE}/installations?connectionId=con_NOAUTH`);
    expect(res.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

// ── Steering connect ──────────────────────────────────────────────────────────

const STEERING_BASE = `/v1/${ORG}/connections/steering`;
/** The steering callback the second app used before ADR-228. Nothing serves it. */
const RETIRED_STEERING_CALLBACK_PATH = "/oauth/github/steering";
const STEERING_USER_ID = "user-id-test";
const STEERING_RETURN_TO = "/onboarding/steering";
/**
 * Where the callback sends every steering outcome: the app's landing, with
 * `return_to` first and the outcome after it (#5151). URLSearchParams encodes
 * each slash in the path.
 */
const STEERING_LANDING = `${APP_URL}/github/steering?return_to=${encodeURIComponent(STEERING_RETURN_TO)}`;

/** Steering runs on the Oxagen GitHub App, so it reads only `GITHUB_APP_*` (ADR-228). */
const STEERING_ENV: Record<string, string | undefined> = {
  ...DEFAULT_ENV,
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "test-app-private-key",
};

/** The keys the start route checks, in the order its 503 names them. */
const STEERING_START_KEYS = [
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALL_STATE_SECRET",
] as const;

/** The keys the callback refuses to run without, for any state. */
const CALLBACK_KEYS = [
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_INSTALL_STATE_SECRET",
] as const;

/** A state signed the way the start route signs one, steering by default. */
function buildPurposeState(overrides: Record<string, unknown> = {}): string {
  const now = Date.now();
  const stateJson = JSON.stringify({
    purpose: "steering",
    orgId: TEST_ORG_ID,
    userId: STEERING_USER_ID,
    returnTo: STEERING_RETURN_TO,
    issuedAt: now,
    expiresAt: now + 10 * 60 * 1000,
    nonce: "test-purpose-nonce",
    ...overrides,
  });
  const hmac = createHmac("sha256", STATE_SECRET)
    .update(stateJson)
    .digest("hex");
  return `${Buffer.from(stateJson).toString("base64url")}.${hmac}`;
}

/**
 * The state a redirect to GitHub carries, after checking its signature
 * against the test secret.
 */
function readRedirectState(location: string | null): Record<string, unknown> {
  expect(location).toBeTruthy();
  const raw = new URL(location as string).searchParams.get("state");
  expect(raw).toBeTruthy();
  const state = raw as string;
  const dot = state.lastIndexOf(".");
  const stateJson = Buffer.from(state.slice(0, dot), "base64url").toString(
    "utf8",
  );
  const hmac = createHmac("sha256", STATE_SECRET)
    .update(stateJson)
    .digest("hex");
  expect(state.slice(dot + 1)).toBe(hmac);
  return JSON.parse(stateJson) as Record<string, unknown>;
}

/** A tx for the token upsert that records the values it inserted. */
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
  const tx = { insert: vi.fn().mockReturnValue(insertChain) };
  return { tx: tx as unknown as TxLike, captured };
}

/**
 * A tx for a select that answers `rows`, whether the query ends at `.where()`
 * or at `.limit()`. The workspace read awaits `.where()` directly.
 */
function makeRowsTx(rows: unknown[]): TxLike {
  const selectChain = { from: vi.fn(), where: vi.fn() };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockImplementation(() =>
    Object.assign(Promise.resolve(rows), {
      limit: vi.fn().mockResolvedValue(rows),
    }),
  );
  return { select: vi.fn().mockReturnValue(selectChain) } as unknown as TxLike;
}

/** Answer the next withSystemDb calls with these txs, in order. */
function queueSystemDb(...txs: TxLike[]) {
  for (const tx of txs) {
    mocks.withSystemDb.mockImplementationOnce((fn: Parameters<DbFn>[0]) =>
      fn(tx),
    );
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
    connection_choices: [],
    updated_at: "2026-09-27T00:00:00.000Z",
  };
}

type SteeringErrorBody = { error?: { code?: string; message?: string } };

describe("GET /v1/:org/connections/steering/github", () => {
  function startSteering(query: Record<string, string | undefined>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, value);
    }
    return authGet(`${STEERING_BASE}/github?${params.toString()}`);
  }

  beforeEach(() => {
    mocks.resolveApiKey.mockResolvedValue(
      makeApiKeyOk({ userId: STEERING_USER_ID }),
    );
    mocks.requireEnv.mockReturnValue(STEERING_ENV);
  });

  it("redirects an install to the Oxagen GitHub App with a signed steering state", async () => {
    const res = await startSteering({
      mode: "install",
      return_to: STEERING_RETURN_TO,
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toMatch(
      new RegExp(
        `^https://github\\.com/apps/${APP_SLUG}/installations/new\\?state=`,
      ),
    );
    // GitHub's install page takes no redirect_uri. The app's first Callback
    // URL answers it (ADR-228).
    expect(new URL(location as string).searchParams.has("redirect_uri")).toBe(
      false,
    );
    const state = readRedirectState(location);
    expect(state).toMatchObject({
      purpose: "steering",
      orgId: TEST_ORG_ID,
      userId: STEERING_USER_ID,
      returnTo: STEERING_RETURN_TO,
    });
    expect(typeof state.nonce).toBe("string");
    expect(Number(state.expiresAt) - Number(state.issuedAt)).toBe(
      10 * 60 * 1000,
    );
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      {
        orgId: TEST_ORG_ID,
        workspaceId: ORG_ONLY_WORKSPACE_ID,
        userId: STEERING_USER_ID,
      },
      SETTINGS_REQUIREMENT,
    );
  });

  it("redirects an authorize to GitHub's OAuth page with the app's client id and no redirect_uri", async () => {
    const res = await startSteering({
      mode: "authorize",
      return_to: STEERING_RETURN_TO,
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://github.com/login/oauth/authorize?")).toBe(
      true,
    );
    const params = new URL(location).searchParams;
    expect(params.get("client_id")).toBe(CLIENT_ID);
    // GitHub refuses a redirect_uri that is not a registered Callback URL,
    // so the authorize leg sends none and returns to the first one.
    expect(params.has("redirect_uri")).toBe(false);
    expect(readRedirectState(location)).toMatchObject({
      purpose: "steering",
      orgId: TEST_ORG_ID,
      userId: STEERING_USER_ID,
    });
  });

  it.each(["steering", "oxagen", "gitlab"])(
    "ignores the retired app=%s parameter and installs the one app",
    async (appParam) => {
      const res = await startSteering({
        app: appParam,
        mode: "install",
        return_to: STEERING_RETURN_TO,
      });

      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toMatch(
        new RegExp(`^https://github\\.com/apps/${APP_SLUG}/installations/new`),
      );
      expect(readRedirectState(location).purpose).toBe("steering");
    },
  );

  it.each(STEERING_START_KEYS)(
    "answers 503 naming %s when it is unset",
    async (key) => {
      mocks.requireEnv.mockReturnValue({ ...STEERING_ENV, [key]: undefined });

      const res = await startSteering({
        mode: "install",
        return_to: STEERING_RETURN_TO,
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as SteeringErrorBody;
      expect(body.error?.code).toBe("github_app_unconfigured");
      expect(body.error?.message).toContain(key);
      expect(res.headers.get("location")).toBeNull();
    },
  );

  it("reads none of the retired steering app's settings", async () => {
    mocks.requireEnv.mockReturnValue({
      ...STEERING_ENV,
      OXAGEN_STEERING_APP_SLUG: "oxagen-steering-retired",
      OXAGEN_STEERING_APP_CLIENT_ID: "Iv1.retired",
    });

    const res = await startSteering({
      mode: "authorize",
      return_to: STEERING_RETURN_TO,
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("retired");
    expect(new URL(location).searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("answers 403 to an org member, with no GitHub URL", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(
      new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "Requires one of the org roles Owner, Admin",
      }),
    );

    const res = await startSteering({
      mode: "install",
      return_to: STEERING_RETURN_TO,
    });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect((JSON.parse(text) as SteeringErrorBody).error?.code).toBe(
      "forbidden",
    );
    expect(text).not.toContain("github.com");
    expect(res.headers.get("location")).toBeNull();
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      {
        orgId: TEST_ORG_ID,
        workspaceId: ORG_ONLY_WORKSPACE_ID,
        userId: STEERING_USER_ID,
      },
      SETTINGS_REQUIREMENT,
    );
  });

  it("answers 403 when the request carries no user, before checking a role", async () => {
    mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());

    const res = await startSteering({
      mode: "install",
      return_to: STEERING_RETURN_TO,
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as SteeringErrorBody;
    expect(body.error?.code).toBe("forbidden");
    expect(mocks.assertOrgRole).not.toHaveBeenCalled();
  });

  it.each([undefined, "uninstall"])(
    "answers 400 to the mode %s",
    async (mode) => {
      const res = await startSteering({
        mode,
        return_to: STEERING_RETURN_TO,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as SteeringErrorBody;
      expect(body.error?.code).toBe("validation_error");
    },
  );

  it.each([
    { name: "a missing return_to", returnTo: undefined },
    { name: "an absolute URL", returnTo: "https://evil.test/steal" },
    { name: "a protocol-relative URL", returnTo: "//evil.test/steal" },
    { name: "a relative path", returnTo: "onboarding/steering" },
    { name: "a backslash", returnTo: "/\\evil.test" },
    { name: "a control character", returnTo: "/onboarding\nsteering" },
    { name: "a delete character", returnTo: "/onboarding\u007fsteering" },
    { name: "513 characters", returnTo: `/${"a".repeat(512)}` },
  ])("answers 400 to $name", async ({ returnTo }) => {
    const res = await startSteering({
      mode: "install",
      return_to: returnTo,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as SteeringErrorBody;
    expect(body.error?.code).toBe("validation_error");
    expect(res.headers.get("location")).toBeNull();
  });

  it("accepts a return_to of exactly 512 characters", async () => {
    const returnTo = `/${"a".repeat(511)}`;
    const res = await startSteering({
      mode: "install",
      return_to: returnTo,
    });

    expect(res.status).toBe(302);
    expect(readRedirectState(res.headers.get("location")).returnTo).toBe(
      returnTo,
    );
  });
});

describe("GET /oauth/github/callback with a steering state (ADR-228)", () => {
  function steeringCallback(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return app.fetch(makeRequest(`${CALLBACK_PATH}?${qs}`));
  }

  /** What GitHub answers for the token exchange and then for /user. */
  function mockGithubExchange(
    token: Record<string, unknown> = {
      access_token: "gho_steering_token",
      token_type: "bearer",
      scope: "",
    },
    user: Record<string, unknown> = {
      id: 4242,
      login: "octo",
      name: null,
      email: "octo@example.test",
    },
  ) {
    mocks.fetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => token })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => user });
  }

  function errorRedirect(code: string) {
    return `${STEERING_LANDING}&steering=error&code=${code}`;
  }

  /** What GitHub answers for the owner's `/user/installations`. */
  function mockInstallations(
    installations: {
      id: number;
      account: { login: string; type: string };
    }[],
  ) {
    mocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          installations: installations.map((i) => ({
            ...i,
            repository_selection: "selected",
          })),
        }),
    });
  }

  const INSTALLATIONS_URL =
    "https://api.github.com/user/installations?per_page=100";

  beforeEach(() => {
    mocks.requireEnv.mockReturnValue(STEERING_ENV);
  });

  it.each(CALLBACK_KEYS)(
    "answers 503 naming %s when it is unset",
    async (key) => {
      mocks.requireEnv.mockReturnValue({ ...STEERING_ENV, [key]: undefined });

      const res = await steeringCallback({
        code: "steering-code",
        state: buildPurposeState(),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain(key);
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it("answers 400 to a steering state whose signature does not match", async () => {
    const good = buildPurposeState();
    const forged = `${good.slice(0, good.lastIndexOf("."))}.${"0".repeat(64)}`;

    const res = await steeringCallback({ code: "steering-code", state: forged });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid state signature");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("answers 400 to an expired steering state", async () => {
    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState({ expiresAt: Date.now() - 1000 }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("expired");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an install state, which only the retired install leg signed",
      state: () => buildPurposeState({ purpose: "install" }),
    },
    {
      name: "a state with an unknown purpose",
      state: () => buildPurposeState({ purpose: "tools" }),
    },
    {
      name: "a steering state whose returnTo leaves the app",
      state: () => buildPurposeState({ returnTo: "//evil.test" }),
    },
    {
      name: "a steering state with no user",
      state: () => buildPurposeState({ userId: "" }),
    },
    {
      name: "a steering state with no organization",
      state: () => buildPurposeState({ orgId: "" }),
    },
  ])("answers 400 to $name and touches nothing", async ({ state }) => {
    const res = await steeringCallback({
      code: "steering-code",
      installation_id: "987654",
      setup_action: "install",
      state: state(),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("not started for this callback");
    expect(vi.mocked(upsertGithubInstallation)).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("serves nothing at the retired steering callback", async () => {
    const res = await app.fetch(
      makeRequest(
        `${RETIRED_STEERING_CALLBACK_PATH}?${new URLSearchParams({
          code: "steering-code",
          state: buildPurposeState(),
        }).toString()}`,
      ),
    );

    expect(res.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("sends the person back with github_install_requested when an owner must approve", async () => {
    const res = await steeringCallback({
      state: buildPurposeState(),
      setup_action: "request",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      errorRedirect("github_install_requested"),
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("sends the person back with github_code_missing when GitHub sends no code", async () => {
    const res = await steeringCallback({ state: buildPurposeState() });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      errorRedirect("github_code_missing"),
    );
  });

  it("sends the person back with github_token_exchange_failed when GitHub refuses the code", async () => {
    mocks.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      errorRedirect("github_token_exchange_failed"),
    );
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("sends the person back with github_token_exchange_failed when the exchange throws", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error("socket hang up"));

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      errorRedirect("github_token_exchange_failed"),
    );
  });

  it("sends the person back with github_user_unreadable when /user fails", async () => {
    mocks.fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "gho_steering_token" }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      errorRedirect("github_user_unreadable"),
    );
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it("sends the person back with store_failed when the upsert returns no row", async () => {
    mockGithubExchange();

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(errorRedirect("store_failed"));
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
  });

  it("stores the token as github_steering and resends each scope that waits on GitHub", async () => {
    mockGithubExchange();
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(
      insert.tx,
      makeRowsTx([{ settings: {} }]),
      makeRowsTx([
        {
          id: "ws-ready",
          settings: {
            steering_repo: { ...reauthorizeState("github"), status: "ready" },
          },
        },
        { id: "ws-github", settings: { steering_repo: reauthorizeState("github") } },
        { id: "ws-gitlab", settings: { steering_repo: reauthorizeState("gitlab") } },
      ]),
    );

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${STEERING_LANDING}&steering=connected`,
    );

    // The code went to GitHub with the Oxagen GitHub App's client, the same
    // one a workspace connect uses (ADR-228), and with no redirect_uri.
    const [tokenUrl, tokenInit] = mocks.fetch.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    expect(tokenUrl).toBe("https://github.com/login/oauth/access_token");
    expect(tokenInit.body.get("client_id")).toBe(CLIENT_ID);
    expect(tokenInit.body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(tokenInit.body.get("code")).toBe("steering-code");
    expect(tokenInit.body.has("redirect_uri")).toBe(false);
    expect(mocks.fetch.mock.calls[1]?.[0]).toBe("https://api.github.com/user");
    // No installation_id came back, so nothing lists installations and the
    // job picks the connection itself.
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.keepSteeringConnection).not.toHaveBeenCalled();
    expect(vi.mocked(upsertGithubInstallation)).not.toHaveBeenCalled();
    // A steering state never reaches the workspace connect's tenant writes.
    expect(mocks.withTenantDb).not.toHaveBeenCalled();

    expect(mocks.encrypt).toHaveBeenCalledWith(
      "gho_steering_token",
      "ingestion:env:v1",
      { adapter: {} },
    );
    expect(insert.captured.values).toMatchObject({
      orgId: TEST_ORG_ID,
      provider: "github_steering",
      providerUserId: "4242",
      providerUserName: "octo",
      providerUserEmail: "octo@example.test",
      accessTokenEnc: {
        keyId: "ingestion:env:v1",
        ciphertext: Buffer.from("encrypted-token").toString("base64"),
      },
      refreshTokenEnc: null,
      expiresAt: null,
      tokenType: "bearer",
      scopes: [],
    });

    // The organization has no state, so it waits on either host. Of the
    // workspaces, only the one stopped for a GitHub authorization waits.
    expect(mocks.startSteeringRepoProvision).toHaveBeenCalledTimes(2);
    expect(mocks.startSteeringRepoProvision).toHaveBeenNthCalledWith(
      1,
      { orgId: TEST_ORG_ID, workspaceId: null, actorUserId: STEERING_USER_ID },
      expect.objectContaining({ status: "provisioning", step: null }),
    );
    expect(mocks.startSteeringRepoProvision).toHaveBeenNthCalledWith(
      2,
      {
        orgId: TEST_ORG_ID,
        workspaceId: "ws-github",
        actorUserId: STEERING_USER_ID,
      },
      expect.objectContaining({ status: "blocked", provider: "github" }),
    );
  });

  it("stores an expiry and the refresh token when GitHub sends them", async () => {
    mockGithubExchange({
      access_token: "gho_steering_token",
      refresh_token: "ghr_steering_refresh",
      expires_in: 28_800,
      token_type: "bearer",
      scope: "repo, workflow",
    });
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([]), makeRowsTx([]));

    const before = Date.now();
    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${STEERING_LANDING}&steering=connected`,
    );
    const expiresAt = insert.captured.values?.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);
    const expiresMs = (expiresAt as Date).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 28_800_000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 28_800_000);
    expect(insert.captured.values?.refreshTokenEnc).not.toBeNull();
    expect(insert.captured.values?.scopes).toEqual(["repo", "workflow"]);
    expect(mocks.encrypt).toHaveBeenCalledWith(
      "ghr_steering_refresh",
      "ingestion:env:v1",
      { adapter: {} },
    );
    // No organization row and no workspaces: nothing to resend.
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
  });

  it("sends the person back with provision_resend_failed when the scope read throws", async () => {
    mockGithubExchange();
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx);
    mocks.withSystemDb.mockImplementationOnce(() =>
      Promise.reject(new Error("connection reset")),
    );

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      errorRedirect("provision_resend_failed"),
    );
  });

  it("records the installation and keeps the one the owner picked before it resends provisioning", async () => {
    mockGithubExchange();
    mockInstallations([
      { id: 101, account: { login: "acme", type: "Organization" } },
      { id: 202, account: { login: "globex", type: "Organization" } },
    ]);
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([{ settings: {} }]), makeRowsTx([]));

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
      installation_id: "202",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${STEERING_LANDING}&steering=connected`,
    );
    // The install goes into the platform registry, as a direct install does.
    expect(vi.mocked(upsertGithubInstallation)).toHaveBeenCalledWith({
      installationId: "202",
      reactivate: true,
    });
    // The id was checked against the owner's own token, not taken on trust.
    const [listUrl, listInit] = mocks.fetch.mock.calls[2] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(listUrl).toBe(INSTALLATIONS_URL);
    expect(listInit.method).toBe("GET");
    expect(listInit.headers.Authorization).toBe("Bearer gho_steering_token");
    // The owner reaches two organizations. The one they installed on is kept.
    expect(mocks.keepSteeringConnection).toHaveBeenCalledTimes(1);
    expect(mocks.keepSteeringConnection).toHaveBeenCalledWith(TEST_ORG_ID, {
      provider: "github",
      installation_id: 202,
      account_login: "globex",
    });
    // Stored before the resend, so pick_connection finds it and does not ask.
    expect(mocks.startSteeringRepoProvision).toHaveBeenCalledTimes(1);
    const kept = mocks.keepSteeringConnection.mock.invocationCallOrder[0];
    const sent = mocks.startSteeringRepoProvision.mock.invocationCallOrder[0];
    expect(kept).toBeLessThan(sent as number);
  });

  it("does not move a connection it just stored", async () => {
    mockGithubExchange();
    mockInstallations([
      { id: 202, account: { login: "globex", type: "Organization" } },
    ]);
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([{ settings: {} }]), makeRowsTx([]));

    await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
      installation_id: "202",
      setup_action: "install",
    });

    expect(mocks.keepSteeringConnection).toHaveBeenCalledTimes(1);
    expect(mocks.moveSteeringInstallation).not.toHaveBeenCalled();
  });

  it("moves a stored connection to the installation the owner just authorized (ADR-228)", async () => {
    mocks.keepSteeringConnection.mockResolvedValueOnce(false);
    mocks.moveSteeringInstallation.mockResolvedValueOnce(101);
    mockGithubExchange();
    mockInstallations([
      { id: 202, account: { login: "globex", type: "Organization" } },
    ]);
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([{ settings: {} }]), makeRowsTx([]));

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
      installation_id: "202",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${STEERING_LANDING}&steering=connected`,
    );
    const connection = {
      provider: "github",
      installation_id: 202,
      account_login: "globex",
    };
    expect(mocks.moveSteeringInstallation).toHaveBeenCalledTimes(1);
    expect(mocks.moveSteeringInstallation).toHaveBeenCalledWith(
      TEST_ORG_ID,
      connection,
      STEERING_USER_ID,
    );
    // Moved before the resend, so provisioning mints for the live installation.
    const moved = mocks.moveSteeringInstallation.mock.invocationCallOrder[0];
    const sent = mocks.startSteeringRepoProvision.mock.invocationCallOrder[0];
    expect(moved).toBeLessThan(sent as number);
  });

  it("sends the person back with store_failed when moving the connection throws (negative)", async () => {
    mocks.keepSteeringConnection.mockResolvedValueOnce(false);
    mocks.moveSteeringInstallation.mockRejectedValueOnce(
      new Error("connection reset"),
    );
    mockGithubExchange();
    mockInstallations([
      { id: 202, account: { login: "globex", type: "Organization" } },
    ]);
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx);

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
      installation_id: "202",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(errorRedirect("store_failed"));
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
  });

  it("still connects when the registry write fails", async () => {
    vi.mocked(upsertGithubInstallation).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    mockGithubExchange();
    mockInstallations([
      { id: 202, account: { login: "globex", type: "Organization" } },
    ]);
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx, makeRowsTx([{ settings: {} }]), makeRowsTx([]));

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
      installation_id: "202",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${STEERING_LANDING}&steering=connected`,
    );
    expect(mocks.keepSteeringConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "an id the owner's token does not list",
      installationId: "303",
      reply: () =>
        mockInstallations([
          { id: 101, account: { login: "acme", type: "Organization" } },
        ]),
    },
    {
      name: "an installation on a personal account",
      installationId: "202",
      reply: () =>
        mockInstallations([
          { id: 202, account: { login: "octo", type: "User" } },
        ]),
    },
    {
      name: "a listing GitHub refuses",
      installationId: "202",
      reply: () => {
        mocks.fetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ message: "Bad credentials" }),
        });
      },
    },
  ])(
    "keeps no installation for $name and still connects (negative)",
    async ({ installationId, reply }) => {
      mockGithubExchange();
      reply();
      const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
      queueSystemDb(insert.tx, makeRowsTx([{ settings: {} }]), makeRowsTx([]));

      const res = await steeringCallback({
        code: "steering-code",
        state: buildPurposeState(),
        installation_id: installationId,
        setup_action: "install",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `${STEERING_LANDING}&steering=connected`,
      );
      expect(mocks.fetch.mock.calls[2]?.[0]).toBe(INSTALLATIONS_URL);
      expect(mocks.keepSteeringConnection).not.toHaveBeenCalled();
      // The job still runs, and picks the connection as it did before.
      expect(mocks.startSteeringRepoProvision).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["12abc", "0", "-5", "99999999999999999999"])(
    "asks GitHub nothing and records nothing about a malformed installation_id %s (negative)",
    async (installationId) => {
      mockGithubExchange();
      const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
      queueSystemDb(insert.tx, makeRowsTx([]), makeRowsTx([]));

      const res = await steeringCallback({
        code: "steering-code",
        state: buildPurposeState(),
        installation_id: installationId,
        setup_action: "install",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `${STEERING_LANDING}&steering=connected`,
      );
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
      expect(mocks.keepSteeringConnection).not.toHaveBeenCalled();
      expect(vi.mocked(upsertGithubInstallation)).not.toHaveBeenCalled();
    },
  );

  it("sends the person back with store_failed when keeping the installation throws", async () => {
    mockGithubExchange();
    mockInstallations([
      { id: 202, account: { login: "globex", type: "Organization" } },
    ]);
    const insert = makeInsertTx([{ id: "oauth-account-uuid" }]);
    queueSystemDb(insert.tx);
    mocks.keepSteeringConnection.mockRejectedValueOnce(
      new Error("connection reset"),
    );

    const res = await steeringCallback({
      code: "steering-code",
      state: buildPurposeState(),
      installation_id: "202",
      setup_action: "install",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(errorRedirect("store_failed"));
    expect(mocks.startSteeringRepoProvision).not.toHaveBeenCalled();
  });
});
