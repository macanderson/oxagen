/**
 * Unit tests for src/routes/v1/github-webhook.ts — the App-level GitHub webhook.
 *
 * Covers:
 * - Missing GITHUB_APP_WEBHOOK_SECRET → 200 ack, logged at error
 * - Invalid HMAC signature → 401
 * - A delivery from another App → 200 ack, nothing dispatched, whatever
 *   secret signed it (#4937)
 * - `ping` event → 200 { pong: true }, no DB/inngest
 * - `installation` deleted → pauses connections, 200
 * - No installation id → 200 { dispatched: 0 }
 * - Happy path (pull_request) → resolves connection, fires entity.received, 200
 * - Repo mismatch → 200 { dispatched: 0 }
 * - parseWebhookEvent returns [] → 200 { dispatched: 0 }
 * - entity.received event shape (sourceRecordType + unwrapped record)
 * - push / pull_request → steering sync request (ADR-184); its failure never
 *   changes the response
 * - push → MCP server discovery (M10, #4682); its failure never changes the
 *   response
 * - pull_request → the pull request's state is stored (ADR-192) once per
 *   delivery with an installation; its failure never changes the response
 * - a primary App delivery that can change a steering repo's health asks
 *   for one health read per scope (S2, #4560, ADR-228), before the lifecycle
 *   answers; its failure never changes the response, and nothing reads the
 *   retired steering app's env
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
  withSystemDb: vi.fn(),
  inngestSend: vi.fn(),
  getConnector: vi.fn(),
  parseWebhookEvent: vi.fn(),
  githubSyncTargets: vi.fn(),
  requestSteeringSync: vi.fn(),
  recordGithubPullRequestState: vi.fn(),
  routeGithubDiscoveryPush: vi.fn(),
  findHealthScopes: vi.fn(),
  // Mirrors the real healthRequests, so the test reads the events it sends.
  healthRequests: vi.fn(
    (
      scopes: { orgId: string; workspaceId: string | null }[],
      trigger: unknown,
    ) =>
      scopes.map((scope) => ({
        name: "steering-repo/health.requested",
        data: {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          key: `${scope.orgId}:${scope.workspaceId ?? "org"}`,
          trigger,
        },
      })),
  ),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(),
  clearHandlersForTests: vi.fn(),
}));

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
  FileNotFoundError: class FileNotFoundError extends Error {},
  FileForbiddenError: class FileForbiddenError extends Error {},
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

// The github_installations registry upsert has its own dedicated suite
// (github-installations.test.ts). Stub it to a no-op so these lifecycle tests
// assert ONLY the connection-pause behavior, not the registry write.
vi.mock("../routes/v1/github-installations", () => ({
  upsertGithubInstallation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/inngest-functions", () => ({
  inngest: { send: mocks.inngestSend, createFunction: vi.fn() },
  functions: [],
}));
vi.mock("@oxagen/inngest-functions/client", () => ({
  inngest: { send: mocks.inngestSend },
}));

vi.mock("@oxagen/ingestion/connectors", () => ({
  getConnector: mocks.getConnector,
}));

// The steering sync request (ADR-184) reads the repository binding registry
// and sends its own event. Its matching logic has its own suite; here it is
// a seam, so these tests assert what the route hands it and that its failure
// never reaches GitHub.
vi.mock("@oxagen/handlers/context.steering.sync.request", () => ({
  githubSyncTargets: mocks.githubSyncTargets,
  requestSteeringSync: mocks.requestSteeringSync,
}));

// Storing the pull request's state (ADR-192) has its own suite; here it is a
// seam, so these tests assert when the route calls it and that its failure
// never reaches GitHub.
vi.mock("@oxagen/handlers/github.pull-request.webhook", () => ({
  githubPullRequestStateDeps: { tag: "real-deps" },
  recordGithubPullRequestState: mocks.recordGithubPullRequestState,
}));

// The MCP server discovery push route (lane M10, #4682) reads Postgres and
// has its own suite. Here it is a seam, so these tests assert which deliveries
// reach it and that its failure never reaches GitHub.
vi.mock("@oxagen/handlers/mcp-studio/discovery/webhook", () => ({
  routeGithubDiscoveryPush: mocks.routeGithubDiscoveryPush,
}));

// The steering repo health scope lookup reads Postgres and has its own suite.
// Here it is a seam. The event mapping (health.events) is the real one.
vi.mock("@oxagen/handlers/steering-repo/health", () => ({
  findHealthScopes: mocks.findHealthScopes,
  healthRequests: mocks.healthRequests,
}));

import { app } from "../app";
import { makeRequest } from "./_helpers";
// The same mocked logger instance the route imports — assert ack-and-drop logs.
import { logger } from "../middleware/logger";
import { upsertGithubInstallation } from "../routes/v1/github-installations";

const SECRET = "test-webhook-secret";
const PRIMARY_APP_ID = "4168398";
// Any App other than the primary one, with a secret of its own. The route
// holds no secret for it (#4937).
const OTHER_APP_ID = "4230117";
const OTHER_APP_SECRET = "other-app-webhook-secret-for-tests";
const PATH = "/webhooks/github/app";

/** Build a signed POST with the correct x-hub-signature-256 header. */
function signedPost(
  event: string,
  bodyObj: unknown,
  opts: { secret?: string; badSig?: boolean; targetId?: string } = {},
): Request {
  const body = JSON.stringify(bodyObj);
  const sig =
    "sha256=" +
    createHmac("sha256", opts.secret ?? SECRET)
      .update(Buffer.from(body))
      .digest("hex");
  return makeRequest(PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": opts.badSig ? "sha256=deadbeef" : sig,
      ...(opts.targetId
        ? { "x-github-hook-installation-target-id": opts.targetId }
        : {}),
    },
    body,
  });
}

/** Combined select+update tx mock. `rows` is what the select resolves to. */
function makeTx(rows: unknown[]) {
  const selectChain = { from: vi.fn(), where: vi.fn() };
  selectChain.from.mockReturnValue(selectChain);
  selectChain.where.mockResolvedValue(rows);

  const updateChain = { set: vi.fn(), where: vi.fn() };
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockResolvedValue([]);

  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue(updateChain),
    _updateChain: updateChain,
  };
}

const CONNECTED_ROW = {
  id: "conn-uuid-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  deliveryConfig: { installationId: "555", owner: "acme", repo: "widgets" },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  mocks.inngestSend.mockResolvedValue({});
  mocks.getConnector.mockReturnValue({
    parseWebhookEvent: mocks.parseWebhookEvent,
  });
  mocks.parseWebhookEvent.mockReturnValue([
    { sourceRecordType: "pull_request", record: { number: 7, title: "PR" } },
  ]);
  mocks.withSystemDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx([CONNECTED_ROW])),
  );
  mocks.githubSyncTargets.mockResolvedValue([]);
  mocks.requestSteeringSync.mockResolvedValue(0);
  mocks.recordGithubPullRequestState.mockResolvedValue({
    outcome: "recorded",
    rows: 1,
  });
  mocks.routeGithubDiscoveryPush.mockResolvedValue(0);
  // No steering repo matches unless a test says so (S2, #4560).
  mocks.findHealthScopes.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  delete process.env.GITHUB_APP_ID;
});

describe("github app webhook – configuration & signature", () => {
  it("acks with 200 and logs an error when GITHUB_APP_WEBHOOK_SECRET is missing", async () => {
    // GitHub records EVERY non-2xx delivery (4xx and 5xx alike) as failed and
    // re-queues it, so any error status on a server misconfiguration produces an
    // infinite retry flood. A missing webhook secret is a server-side config
    // problem the request can't fix, so we ACK with 200 (drop the event) to stop
    // GitHub retrying, and log loudly so operators catch the misconfiguration.
    // The real fix is setting GITHUB_APP_WEBHOOK_SECRET in Vercel.
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    const res = await app.fetch(
      signedPost("pull_request", { installation: { id: 555 } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      received: boolean;
      dispatched: number;
      reason?: string;
    };
    expect(body.received).toBe(true);
    expect(body.dispatched).toBe(0);
    // Operators must see the misconfiguration — assert it was logged at error.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "github_app_webhook_secret_missing" }),
      expect.stringContaining("GITHUB_APP_WEBHOOK_SECRET"),
    );
    // Nothing is dispatched when we cannot verify the signature.
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("returns 200 with dispatched>0 for a well-formed signed webhook (no retry flood)", async () => {
    // Regression guard for the webhook-flood incident: a properly-signed webhook
    // with the secret configured must return a 2xx ack (so GitHub does not retry)
    // and dispatch the event. Pre-condition: secret IS set (beforeEach).
    expect(process.env.GITHUB_APP_WEBHOOK_SECRET).toBeDefined();
    const res = await app.fetch(
      signedPost("pull_request", {
        action: "opened",
        installation: { id: 555 },
        repository: { full_name: "acme/widgets" },
        pull_request: { number: 7 },
      }),
    );
    // 2xx ack is what stops GitHub's retry queue.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatched: number };
    expect(body.dispatched).toBeGreaterThan(0);
  });

  it("returns 401 when the signature header is absent", async () => {
    const res = await app.fetch(
      makeRequest(PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
        },
        body: JSON.stringify({ installation: { id: 555 } }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on an invalid signature", async () => {
    const res = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        { badSig: true },
      ),
    );
    expect(res.status).toBe(401);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  // ── Other Apps (#4937) ────────────────────────────────────────────────────
  // Only the Oxagen GitHub App (GITHUB_APP_ID) delivers here on purpose. A
  // delivery whose target ID names any other App is acked with 200 and
  // dropped, because GitHub retries every non-2xx answer. The route holds no
  // other App's secret, so no other secret can verify a delivery.

  it("acks a delivery from another App with 200 and dispatches nothing", async () => {
    process.env.GITHUB_APP_ID = PRIMARY_APP_ID;

    const res = await app.fetch(
      signedPost(
        "pull_request",
        {
          action: "opened",
          installation: { id: 555 },
          repository: { full_name: "acme/widgets" },
          pull_request: { number: 7 },
        },
        { secret: OTHER_APP_SECRET, targetId: OTHER_APP_ID },
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      dispatched: 0,
      reason: "not the primary app",
    });
    // Nothing downstream runs for it.
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
    expect(mocks.githubSyncTargets).not.toHaveBeenCalled();
    expect(mocks.recordGithubPullRequestState).not.toHaveBeenCalled();
    expect(mocks.findHealthScopes).not.toHaveBeenCalled();
    // One log line names the sender.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "webhook_from_other_app",
        targetId: OTHER_APP_ID,
      }),
      expect.stringContaining("GITHUB_APP_ID"),
    );
  });

  it("does not let another App's secret authorise a delivery claiming to be the primary App", async () => {
    // Accepting whichever secret happens to match would let any App's secret
    // authorise a payload that claims to come from the primary App.
    process.env.GITHUB_APP_ID = PRIMARY_APP_ID;

    const res = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        { secret: OTHER_APP_SECRET, targetId: PRIMARY_APP_ID },
      ),
    );

    expect(res.status).toBe(401);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("verifies a delivery with no target ID as the primary App's", async () => {
    // GitHub sends the target ID header, but a delivery without it is read as
    // the primary App's and verified, not dropped.
    process.env.GITHUB_APP_ID = PRIMARY_APP_ID;

    const signedByPrimary = await app.fetch(
      signedPost("pull_request", { installation: { id: 555 } }),
    );
    expect(signedByPrimary.status).toBe(200);
    expect(await signedByPrimary.json()).toEqual({
      received: true,
      dispatched: 1,
    });

    const signedByOther = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        { secret: OTHER_APP_SECRET },
      ),
    );
    expect(signedByOther.status).toBe(401);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("treats a delivery as the primary App's when GITHUB_APP_ID is not configured", async () => {
    // GITHUB_APP_ID is what tells the primary App from the others, and it is
    // optional. A deployment that never set it has only the primary App.
    // GitHub still sends the target ID header, and reading that as "another
    // App" would drop every real primary delivery.
    delete process.env.GITHUB_APP_ID;

    const res = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        { secret: SECRET, targetId: PRIMARY_APP_ID },
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, dispatched: 1 });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns 401 when signed with the wrong secret", async () => {
    const res = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        { secret: "wrong" },
      ),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 on a validly-signed but non-JSON body", async () => {
    const body = "this-is-not-json";
    const sig =
      "sha256=" +
      createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
    const res = await app.fetch(
      makeRequest(PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": sig,
        },
        body,
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("github app webhook – lifecycle events", () => {
  it("acks ping without touching DB or inngest", async () => {
    const res = await app.fetch(
      signedPost("ping", { zen: "Keep it logically awesome." }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pong: boolean };
    expect(body.pong).toBe(true);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("pauses connections when an installation is deleted", async () => {
    const tx = makeTx([]);
    mocks.withSystemDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const res = await app.fetch(
      signedPost("installation", {
        action: "deleted",
        installation: { id: 555 },
      }),
    );
    expect(res.status).toBe(200);
    expect(tx.update).toHaveBeenCalled();
    expect(tx._updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("acks installation events that are not deletions without pausing", async () => {
    const tx = makeTx([]);
    mocks.withSystemDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const res = await app.fetch(
      signedPost("installation", {
        action: "created",
        installation: { id: 555 },
      }),
    );
    expect(res.status).toBe(200);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("acks an installation event with no action field", async () => {
    const tx = makeTx([]);
    mocks.withSystemDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const res = await app.fetch(
      signedPost("installation", { installation: { id: 555 } }),
    );
    expect(res.status).toBe(200);
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe("github app webhook – routing & dispatch", () => {
  it("dispatches entity.received for a matching connection", async () => {
    const res = await app.fetch(
      signedPost("pull_request", {
        action: "opened",
        installation: { id: 555 },
        repository: { full_name: "acme/widgets" },
        pull_request: { number: 7, title: "PR" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatched: number };
    expect(body.dispatched).toBe(1);

    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    const sent = mocks.inngestSend.mock.calls[0]?.[0] as Array<{
      name: string;
      data: {
        connectionId: string;
        connectorType: string;
        sourceRecordType: string;
        payload: unknown;
      };
    }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe("ingestion/entity.received");
    expect(sent[0]?.data.connectionId).toBe("conn-uuid-1");
    expect(sent[0]?.data.connectorType).toBe("github");
    expect(sent[0]?.data.sourceRecordType).toBe("pull_request");
    expect(sent[0]?.data.payload).toEqual({ number: 7, title: "PR" });
  });

  it("fans out to all installation connections for events without a repository", async () => {
    // No `repository` in the payload (org-level event) → repo filter is skipped.
    const res = await app.fetch(
      signedPost("pull_request", {
        installation: { id: 555 },
        pull_request: { number: 7 },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
  });

  it("dispatches nothing when the connector has no parseWebhookEvent", async () => {
    mocks.getConnector.mockReturnValue({});
    const res = await app.fetch(
      signedPost("pull_request", {
        installation: { id: 555 },
        repository: { full_name: "acme/widgets" },
        pull_request: { number: 7 },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(0);
  });

  it("handles a null extracted record without throwing", async () => {
    mocks.parseWebhookEvent.mockReturnValue([
      { sourceRecordType: "repository", record: null },
    ]);
    const res = await app.fetch(
      signedPost("repository", {
        installation: { id: 555 },
        repository: { full_name: "acme/widgets" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
  });

  it("dispatches when the event header is absent (empty event name)", async () => {
    const body = JSON.stringify({
      installation: { id: 555 },
      repository: { full_name: "acme/widgets" },
      pull_request: { number: 7 },
    });
    const sig =
      "sha256=" +
      createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex");
    const res = await app.fetch(
      makeRequest(PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sig,
        },
        body,
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
  });

  it("does not dispatch when the event repo does not match the connection", async () => {
    const res = await app.fetch(
      signedPost("pull_request", {
        installation: { id: 555 },
        repository: { full_name: "acme/other-repo" },
        pull_request: { number: 7 },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(0);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("returns dispatched:0 when the payload carries no installation id", async () => {
    const res = await app.fetch(
      signedPost("pull_request", { pull_request: { number: 1 } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(0);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("returns dispatched:0 when the connector extracts no records", async () => {
    mocks.parseWebhookEvent.mockReturnValue([]);
    const res = await app.fetch(
      signedPost("star", {
        action: "created",
        installation: { id: 555 },
        repository: { full_name: "acme/widgets" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(0);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("dispatches records that lack sha/id/number (idempotency key falls back)", async () => {
    mocks.parseWebhookEvent.mockReturnValue([
      { sourceRecordType: "repository", record: {} },
    ]);
    const res = await app.fetch(
      signedPost("repository", {
        action: "edited",
        installation: { id: 555 },
        repository: { full_name: "acme/widgets" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
    const sent = mocks.inngestSend.mock.calls[0]?.[0] as Array<{
      data: { idempotencyKey: string };
    }>;
    expect(sent[0]?.data.idempotencyKey).toContain(":record");
  });

  it("fans out one event per record for a multi-commit push", async () => {
    mocks.parseWebhookEvent.mockReturnValue([
      { sourceRecordType: "commit", record: { sha: "a" } },
      { sourceRecordType: "commit", record: { sha: "b" } },
    ]);
    const res = await app.fetch(
      signedPost("push", {
        installation: { id: 555 },
        repository: { full_name: "acme/widgets" },
        ref: "refs/heads/main",
        commits: [{ id: "a" }, { id: "b" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(2);
    const sent = mocks.inngestSend.mock.calls[0]?.[0] as unknown[];
    expect(sent).toHaveLength(2);
  });
});

describe("github app webhook – MCP server discovery on a push (M10)", () => {
  const PUSH = {
    ref: "refs/heads/main",
    installation: { id: 555 },
    repository: { id: 90210, full_name: "acme/widgets" },
    commits: [{ added: [], modified: ["specs/stripe.yaml"], removed: [] }],
  };

  it("hands a verified push's body to the discovery route", async () => {
    mocks.routeGithubDiscoveryPush.mockResolvedValue(1);
    const res = await app.fetch(signedPost("push", PUSH));
    expect(res.status).toBe(200);
    expect(mocks.routeGithubDiscoveryPush).toHaveBeenCalledTimes(1);
    expect(mocks.routeGithubDiscoveryPush).toHaveBeenCalledWith(PUSH);
  });

  it("hands over a push that carries no installation", async () => {
    // A definition in a repository linked without the App still changes.
    const { installation: _installation, ...body } = PUSH;
    const res = await app.fetch(signedPost("push", body));
    expect(res.status).toBe(200);
    expect(mocks.routeGithubDiscoveryPush).toHaveBeenCalledWith(body);
  });

  it.each(["pull_request", "ping", "issues"])(
    "does not hand over a %s delivery",
    async (event) => {
      const res = await app.fetch(signedPost(event, PUSH));
      expect(res.status).toBe(200);
      expect(mocks.routeGithubDiscoveryPush).not.toHaveBeenCalled();
    },
  );

  it("does not hand over a push whose signature fails", async () => {
    const res = await app.fetch(signedPost("push", PUSH, { badSig: true }));
    expect(res.status).toBe(401);
    expect(mocks.routeGithubDiscoveryPush).not.toHaveBeenCalled();
  });

  it("answers GitHub as usual and logs when the discovery route fails", async () => {
    // The server's next scheduled discovery reads the definition anyway, so
    // a failure here costs a log line and nothing else.
    mocks.routeGithubDiscoveryPush.mockRejectedValue(new Error("pg down"));
    const res = await app.fetch(signedPost("push", PUSH));
    expect(res.status).toBe(200);
    expect(mocks.requestSteeringSync).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("MCP server discovery"),
    );
  });
});

describe("github app webhook – steering sync request (ADR-184)", () => {
  const TARGETS = [
    { orgId: "org-1", workspaceId: "ws-1" },
    { orgId: "org-2", workspaceId: "ws-2" },
  ];

  it("asks for a sync on a push, with the event, the body and the installation", async () => {
    mocks.githubSyncTargets.mockResolvedValue(TARGETS);
    const body = {
      ref: "refs/heads/main",
      installation: { id: 555 },
      repository: { id: 90210, full_name: "acme/widgets" },
    };
    const res = await app.fetch(signedPost("push", body));
    expect(res.status).toBe(200);
    expect(mocks.githubSyncTargets).toHaveBeenCalledTimes(1);
    expect(mocks.githubSyncTargets).toHaveBeenCalledWith({
      eventName: "push",
      body,
      installationId: "555",
    });
    // The targets go through untouched: the route decides nothing about
    // which workspaces sync.
    expect(mocks.requestSteeringSync).toHaveBeenCalledTimes(1);
    expect(mocks.requestSteeringSync).toHaveBeenCalledWith(TARGETS, "push");
  });

  it("asks for a sync on a pull_request delivery, with that reason", async () => {
    mocks.githubSyncTargets.mockResolvedValue(TARGETS);
    const body = {
      action: "closed",
      installation: { id: 555 },
      repository: { id: 90210, full_name: "acme/widgets" },
      pull_request: { number: 7, base: { ref: "main" } },
    };
    const res = await app.fetch(signedPost("pull_request", body));
    expect(res.status).toBe(200);
    expect(mocks.githubSyncTargets).toHaveBeenCalledWith({
      eventName: "pull_request",
      body,
      installationId: "555",
    });
    expect(mocks.requestSteeringSync).toHaveBeenCalledWith(
      TARGETS,
      "pull_request",
    );
  });

  it("asks for a sync on a push that carries no installation", async () => {
    // The sync sits above the early return for a delivery with no
    // installation. A workspace bound through a repository binding does not
    // need one, so moving the request below that return would silently stop
    // its syncs.
    const body = {
      ref: "refs/heads/main",
      repository: { id: 90210, full_name: "acme/widgets" },
    };
    const res = await app.fetch(signedPost("push", body));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(0);
    expect(mocks.githubSyncTargets).toHaveBeenCalledWith({
      eventName: "push",
      body,
      installationId: null,
    });
    expect(mocks.requestSteeringSync).toHaveBeenCalledTimes(1);
  });

  it("asks for a sync on a push to a repository that is not an ingestion source", async () => {
    // The ingestion routing answers early when no connection matches the
    // repository. A main repository with no ingestion connection still syncs.
    const res = await app.fetch(
      signedPost("push", {
        ref: "refs/heads/main",
        installation: { id: 555 },
        repository: { id: 1, full_name: "acme/other-repo" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(0);
    expect(mocks.requestSteeringSync).toHaveBeenCalledTimes(1);
  });

  it.each(["ping", "issues", "installation", "star"])(
    "does not ask for a sync on a %s delivery",
    async (event) => {
      const res = await app.fetch(
        signedPost(event, {
          action: "created",
          installation: { id: 555 },
          repository: { id: 90210, full_name: "acme/widgets" },
        }),
      );
      expect(res.status).toBe(200);
      expect(mocks.githubSyncTargets).not.toHaveBeenCalled();
      expect(mocks.requestSteeringSync).not.toHaveBeenCalled();
    },
  );

  it("does not ask for a sync on a delivery whose signature fails", async () => {
    const res = await app.fetch(
      signedPost(
        "push",
        { ref: "refs/heads/main", installation: { id: 555 } },
        { badSig: true },
      ),
    );
    expect(res.status).toBe(401);
    expect(mocks.githubSyncTargets).not.toHaveBeenCalled();
  });

  it("answers GitHub as usual and logs when finding the targets fails", async () => {
    // GitHub retries a failed delivery and disables a hook that keeps
    // failing. The five-minute sweep syncs every main repository anyway, so a
    // failure here must cost nothing but a log line: same 200, same ingestion.
    mocks.githubSyncTargets.mockRejectedValue(new Error("pool exhausted"));
    const res = await app.fetch(
      signedPost("push", {
        ref: "refs/heads/main",
        installation: { id: 555 },
        repository: { id: 90210, full_name: "acme/widgets" },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
    expect(mocks.requestSteeringSync).not.toHaveBeenCalled();
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    const sent = mocks.inngestSend.mock.calls[0]?.[0] as Array<{
      name: string;
    }>;
    expect(sent[0]?.name).toBe("ingestion/entity.received");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "push", err: expect.any(Error) }),
      expect.stringContaining("steering sync"),
    );
  });

  it("answers GitHub as usual and logs when sending the request fails", async () => {
    // The send is the likelier failure in practice: the event service is
    // down while the database is fine.
    mocks.githubSyncTargets.mockResolvedValue(TARGETS);
    mocks.requestSteeringSync.mockRejectedValue(new Error("inngest 503"));
    const res = await app.fetch(
      signedPost("pull_request", {
        action: "closed",
        installation: { id: 555 },
        repository: { id: 90210, full_name: "acme/widgets" },
        pull_request: { number: 7, base: { ref: "main" } },
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "pull_request" }),
      expect.stringContaining("steering sync"),
    );
  });
});

describe("github app webhook – pull request state (ADR-192)", () => {
  const PR_BODY = {
    action: "closed",
    installation: { id: 555 },
    repository: { id: 90210, full_name: "acme/widgets" },
    pull_request: {
      number: 7,
      state: "closed",
      merged: true,
      updated_at: "2026-09-25T10:00:00Z",
    },
  };

  it("stores the state once per pull_request delivery, with the body and the installation", async () => {
    const res = await app.fetch(signedPost("pull_request", PR_BODY));
    expect(res.status).toBe(200);
    expect(mocks.recordGithubPullRequestState).toHaveBeenCalledTimes(1);
    expect(mocks.recordGithubPullRequestState).toHaveBeenCalledWith(
      { tag: "real-deps" },
      { body: PR_BODY, installationId: "555" },
    );
    // Ingestion still runs after it.
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
  });

  it("stores nothing for a delivery with no installation (negative)", async () => {
    const { installation: _installation, ...body } = PR_BODY;
    const res = await app.fetch(signedPost("pull_request", body));
    expect(res.status).toBe(200);
    expect(mocks.recordGithubPullRequestState).not.toHaveBeenCalled();
  });

  it.each(["push", "issues", "ping"])(
    "stores nothing for a %s delivery (negative)",
    async (event) => {
      const res = await app.fetch(signedPost(event, PR_BODY));
      expect(res.status).toBe(200);
      expect(mocks.recordGithubPullRequestState).not.toHaveBeenCalled();
    },
  );

  it("answers GitHub as usual and logs when storing the state fails (negative)", async () => {
    mocks.recordGithubPullRequestState.mockRejectedValue(new Error("pg down"));
    const res = await app.fetch(signedPost("pull_request", PR_BODY));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "pull_request" }),
      expect.stringContaining("pull request's state"),
    );
  });
});

describe("github app webhook – steering repo health read (S2, #4560, ADR-228)", () => {
  // The app that carried steering before ADR-228. Nothing reads its env now,
  // and it still delivers to this route (#4937).
  const RETIRED_STEERING_APP_ID = "5121606";
  const RETIRED_STEERING_SECRET = "retired-steering-app-secret-for-tests";
  const STEERING_REPO_ID = 904211873;
  const RULESET_DELETED = {
    action: "deleted",
    repository_ruleset: {
      id: 3071,
      name: "Oxagen merges",
      updated_at: "2026-09-26T21:02:48Z",
    },
    repository: { id: STEERING_REPO_ID, full_name: "acme/oxagen" },
    installation: { id: 61200044 },
    sender: { login: "dana-ops" },
  };
  const PR_OPENED = {
    action: "opened",
    installation: { id: 555 },
    repository: { id: 90210, full_name: "acme/widgets" },
    pull_request: { number: 7, head: { sha: "abc123" } },
    sender: { login: "dana-ops" },
  };
  const SCOPES = [
    { orgId: "org-1", workspaceId: null },
    { orgId: "org-1", workspaceId: "ws-1" },
  ];

  beforeEach(() => {
    process.env.GITHUB_APP_ID = PRIMARY_APP_ID;
    mocks.findHealthScopes.mockResolvedValue(SCOPES);
  });

  afterEach(() => {
    delete process.env.OXAGEN_STEERING_APP_ID;
    delete process.env.OXAGEN_STEERING_APP_WEBHOOK_SECRET;
  });

  const fromPrimaryApp = (
    event: string,
    body: unknown,
    opts: { badSig?: boolean } = {},
  ) =>
    app.fetch(
      signedPost(event, body, {
        targetId: PRIMARY_APP_ID,
        ...(opts.badSig ? { badSig: true } : {}),
      }),
    );

  it("asks for one health read per scope that holds the repository", async () => {
    const res = await fromPrimaryApp("repository_ruleset", RULESET_DELETED);
    expect(res.status).toBe(200);
    // The steering repo is not an ingestion source, so ingestion sends nothing.
    expect(await res.json()).toEqual({ received: true, dispatched: 0 });
    expect(mocks.findHealthScopes).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        repository_ids: [STEERING_REPO_ID],
        installation_id: null,
      }),
    );
    const trigger = expect.objectContaining({
      reason: "repository_ruleset.deleted",
      actor: "dana-ops",
      at: "2026-09-26T21:02:48.000Z",
    });
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledWith([
      {
        name: "steering-repo/health.requested",
        data: { orgId: "org-1", workspaceId: null, key: "org-1:org", trigger },
      },
      {
        name: "steering-repo/health.requested",
        data: {
          orgId: "org-1",
          workspaceId: "ws-1",
          key: "org-1:ws-1",
          trigger,
        },
      },
    ]);
  });

  it("reads health before the installation lifecycle answers", async () => {
    const res = await fromPrimaryApp("installation", {
      action: "deleted",
      installation: {
        id: 61200044,
        account: { login: "acme", id: 9, type: "Organization" },
        updated_at: "2026-09-26T21:02:48Z",
      },
      repositories: [{ id: STEERING_REPO_ID }],
      sender: { login: "dana-ops" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      lifecycle: "installation",
      action: "deleted",
    });
    expect(mocks.findHealthScopes).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github",
        repository_ids: [STEERING_REPO_ID],
        installation_id: 61200044,
      }),
    );
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
  });

  it("still records and pauses an uninstall when the health read fails", async () => {
    mocks.findHealthScopes.mockRejectedValue(new Error("pg down"));
    const tx = makeTx([]);
    mocks.withSystemDb.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const res = await fromPrimaryApp("installation", {
      action: "deleted",
      installation: {
        id: 61200044,
        account: { login: "acme", id: 9, type: "Organization" },
        updated_at: "2026-09-26T21:02:48Z",
      },
      repositories: [{ id: STEERING_REPO_ID }],
      sender: { login: "dana-ops" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      lifecycle: "installation",
      action: "deleted",
    });
    expect(vi.mocked(upsertGithubInstallation)).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "61200044",
        deletedAt: expect.any(Date),
      }),
    );
    expect(tx._updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "installation.deleted" }),
      expect.stringContaining("could not request a steering repo health check"),
    );
    // The read runs first. Paused connections could hide the scopes it needs.
    const read = mocks.findHealthScopes.mock.invocationCallOrder[0];
    const recorded =
      vi.mocked(upsertGithubInstallation).mock.invocationCallOrder[0];
    expect(read).toBeLessThan(recorded as number);
  });

  it("keeps the delivery on its path after the health read", async () => {
    const res = await fromPrimaryApp("pull_request", PR_OPENED);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
    expect(mocks.findHealthScopes).toHaveBeenCalledTimes(1);
    expect(mocks.recordGithubPullRequestState).toHaveBeenCalledTimes(1);
    expect(mocks.requestSteeringSync).toHaveBeenCalledTimes(1);
    // One send for the health reads, one for ingestion.
    expect(mocks.inngestSend).toHaveBeenCalledTimes(2);
  });

  it("asks for no health read on a delivery from another App", async () => {
    const res = await app.fetch(
      signedPost("repository_ruleset", RULESET_DELETED, {
        secret: OTHER_APP_SECRET,
        targetId: OTHER_APP_ID,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      dispatched: 0,
      reason: "not the primary app",
    });
    expect(mocks.findHealthScopes).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("acks and drops a delivery from the retired steering app", async () => {
    // The retired steering app still delivers here. With its old env still
    // set, the route reads none of it: the delivery gets 200 so GitHub stops
    // retrying it, and nothing runs (#4937).
    process.env.OXAGEN_STEERING_APP_ID = RETIRED_STEERING_APP_ID;
    process.env.OXAGEN_STEERING_APP_WEBHOOK_SECRET = RETIRED_STEERING_SECRET;
    const res = await app.fetch(
      signedPost("repository_ruleset", RULESET_DELETED, {
        secret: RETIRED_STEERING_SECRET,
        targetId: RETIRED_STEERING_APP_ID,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      received: true,
      dispatched: 0,
      reason: "not the primary app",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "webhook_from_other_app",
        targetId: RETIRED_STEERING_APP_ID,
      }),
      expect.any(String),
    );
    expect(mocks.findHealthScopes).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("refuses the retired steering app's secret on a delivery claiming the primary App", async () => {
    // Its old env is still set, and the route reads none of it.
    process.env.OXAGEN_STEERING_APP_ID = RETIRED_STEERING_APP_ID;
    process.env.OXAGEN_STEERING_APP_WEBHOOK_SECRET = RETIRED_STEERING_SECRET;
    const res = await app.fetch(
      signedPost("repository_ruleset", RULESET_DELETED, {
        secret: RETIRED_STEERING_SECRET,
        targetId: PRIMARY_APP_ID,
      }),
    );
    expect(res.status).toBe(401);
    expect(mocks.findHealthScopes).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("returns 401 on a bad signature and asks for nothing", async () => {
    const res = await fromPrimaryApp("repository_ruleset", RULESET_DELETED, {
      badSig: true,
    });
    expect(res.status).toBe(401);
    expect(mocks.findHealthScopes).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("acks a ping without a health read", async () => {
    const res = await fromPrimaryApp("ping", { zen: "Design for failure." });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, pong: true });
    expect(mocks.findHealthScopes).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["issues", { action: "opened", repository: { id: STEERING_REPO_ID } }],
    [
      "pull_request",
      {
        action: "labeled",
        repository: { id: STEERING_REPO_ID },
        pull_request: { number: 42, head: { sha: "c3d2e1f0" } },
      },
    ],
    [
      "push",
      { ref: "refs/heads/context/x", repository: { id: STEERING_REPO_ID } },
    ],
    ["repository_ruleset", [RULESET_DELETED]],
  ])(
    "asks for nothing on a %s delivery that cannot change health",
    async (event, body) => {
      const res = await fromPrimaryApp(event, body);
      expect(res.status).toBe(200);
      expect(mocks.findHealthScopes).not.toHaveBeenCalled();
      expect(mocks.inngestSend).not.toHaveBeenCalled();
    },
  );

  it("sends nothing when no scope holds the repository", async () => {
    mocks.findHealthScopes.mockResolvedValue([]);
    const res = await fromPrimaryApp("repository_ruleset", RULESET_DELETED);
    expect(await res.json()).toEqual({ received: true, dispatched: 0 });
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("acks and logs when the request cannot be sent", async () => {
    mocks.inngestSend.mockRejectedValue(new Error("event bus down"));
    const res = await fromPrimaryApp("repository_ruleset", RULESET_DELETED);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, dispatched: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "repository_ruleset.deleted" }),
      expect.stringContaining("could not request a steering repo health check"),
    );
  });

  it("still ingests and logs when the scope lookup fails", async () => {
    mocks.findHealthScopes.mockRejectedValue(new Error("pg down"));
    const res = await fromPrimaryApp("pull_request", PR_OPENED);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { dispatched: number }).dispatched).toBe(1);
    expect(mocks.recordGithubPullRequestState).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "pull_request.opened" }),
      expect.stringContaining("could not request a steering repo health check"),
    );
  });
});
