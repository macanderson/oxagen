/**
 * Unit tests for src/routes/v1/github-webhook.ts — the App-level GitHub webhook.
 *
 * Covers:
 * - Missing GITHUB_APP_WEBHOOK_SECRET → 503
 * - Invalid HMAC signature → 401
 * - `ping` event → 200 { pong: true }, no DB/inngest
 * - `installation` deleted → pauses connections, 200
 * - No installation id → 200 { dispatched: 0 }
 * - Happy path (pull_request) → resolves connection, fires entity.received, 200
 * - Repo mismatch → 200 { dispatched: 0 }
 * - parseWebhookEvent returns [] → 200 { dispatched: 0 }
 * - entity.received event shape (sourceRecordType + unwrapped record)
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

import { app } from "../app";
import { makeRequest } from "./_helpers";
// The same mocked logger instance the route imports — assert ack-and-drop logs.
import { logger } from "../middleware/logger";

const SECRET = "test-webhook-secret";
const SECOND_SECRET = "second-app-webhook-secret-for-tests";
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
});

afterEach(() => {
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
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

  // ── Second App ────────────────────────────────────────────────────────────
  // Two GitHub Apps deliver to this one endpoint. oxagen-sh (4055615) signs
  // with GITHUB_WEBHOOK_SECRET, confirmed by HMAC-verifying a captured
  // delivery; the route must know both Apps' secrets so neither App's
  // deliveries are rejected 401.

  it("accepts the second App's delivery, signed with its own secret", async () => {
    process.env.GITHUB_APP_ID = "4168398";
    process.env.GITHUB_WEBHOOK_SECRET = SECOND_SECRET;

    const res = await app.fetch(
      signedPost(
        "pull_request",
        {
          action: "opened",
          installation: { id: 555 },
          repository: { full_name: "acme/widgets" },
          pull_request: { number: 7 },
        },
        { secret: SECOND_SECRET, targetId: "4055615" },
      ),
    );

    expect(res.status).toBe(200);
  });

  it("does not let the second App's secret authorise a delivery claiming to be the primary App", async () => {
    // The whole point of keying on the sender: accepting whichever secret
    // happens to match would mean either secret authorises either App.
    process.env.GITHUB_APP_ID = "4168398";
    process.env.GITHUB_WEBHOOK_SECRET = SECOND_SECRET;

    const res = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        {
          secret: SECOND_SECRET,
          targetId: "4168398",
        },
      ),
    );

    expect(res.status).toBe(401);
  });

  it("acks a second-App delivery when no secret is configured for it", async () => {
    process.env.GITHUB_APP_ID = "4168398";
    delete process.env.GITHUB_WEBHOOK_SECRET;

    const res = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        {
          secret: SECOND_SECRET,
          targetId: "4055615",
        },
      ),
    );

    // 200, not 401 — an unknown signer must not become a retry flood.
    expect(res.status).toBe(200);
  });

  it("treats a delivery as the primary App's when GITHUB_APP_ID is not configured", async () => {
    // GITHUB_APP_ID is what tells the two Apps apart and it is optional, so a
    // deployment that never set it has only the primary App. GitHub still
    // sends the target-id header, and reading that as "not the primary App"
    // routed real primary deliveries to the second App's secret: 401 here,
    // or an acked-and-dropped 200 with no second secret configured.
    delete process.env.GITHUB_APP_ID;
    process.env.GITHUB_WEBHOOK_SECRET = SECOND_SECRET;

    const res = await app.fetch(
      signedPost(
        "pull_request",
        { installation: { id: 555 } },
        {
          secret: SECRET,
          targetId: "4168398",
        },
      ),
    );

    expect(res.status).toBe(200);
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
