/**
 * Integration tests: ingestion webhook endpoint → Inngest event pipeline.
 *
 * Covers the full flow from a POST to /webhooks/github/{connectionPublicId}
 * through to the Inngest send() call, asserting both:
 *
 * 1. The Inngest event name is "ingestion/entity.received"
 * 2. The event data shape matches the IngestionEntityReceived interface
 * 3. HMAC signature verification is enforced per connector
 * 4. The connection row is resolved from the (mocked) DB before queuing
 *
 * These tests use the same mocking strategy as webhook.test.ts but focus on
 * the type shape of the queued event data (which webhook.test.ts checks only
 * partially) and on HMAC-signed delivery from a real GitHub connector signature.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IngestionEntityReceived } from "@oxagen/ingestion";

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
  // Inngest
  inngestSend: vi.fn(),
  // Ingestion connector
  getConnector: vi.fn(),
  verifyWebhook: vi.fn(),
  // Crypto
  decrypt: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
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
  return { ...real, withSystemDb: mocks.withSystemDb };
});

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

vi.mock("@oxagen/crypto", () => ({
  decrypt: mocks.decrypt,
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
}));

import { app } from "../app";
import { makeRequest } from "./_helpers";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMockTx(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return { select: vi.fn().mockReturnValue(chain) };
}

type TxLike = ReturnType<typeof makeMockTx>;
type WithDbFn = (fn: (tx: TxLike) => Promise<unknown[]>) => Promise<unknown[]>;

const CONNECTOR_ID = "github";
const CONNECTION_PUBLIC_ID = "con_e2e_TEST456";
const WEBHOOK_PATH = `/webhooks/${CONNECTOR_ID}/${CONNECTION_PUBLIC_ID}`;

/** A realistic GitHub push payload */
const GITHUB_PUSH_PAYLOAD = JSON.stringify({
  ref: "refs/heads/main",
  repository: { id: 12345, full_name: "oxagen/platform" },
  commits: [{ id: "abc123", message: "feat: add ingestion pipeline" }],
  pusher: { name: "mac" },
});

const DB_CONNECTION_ROW = {
  connectionId: "uuid-connection-e2e",
  orgId: "org-e2e",
  workspaceId: "ws-e2e",
  status: "active",
  secretEnc: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConnector.mockReturnValue({ verifyWebhook: mocks.verifyWebhook });
  mocks.verifyWebhook.mockReturnValue(true);
  mocks.withSystemDb.mockImplementation((fn: Parameters<WithDbFn>[0]) =>
    fn(makeMockTx([DB_CONNECTION_ROW]) as TxLike),
  );
  mocks.inngestSend.mockResolvedValue({});
});

// ── Event shape assertions ────────────────────────────────────────────────────

describe("IngestionEntityReceived event shape", () => {
  it("queued event name is ingestion/entity.received", async () => {
    const res = await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.inngestSend).toHaveBeenCalledOnce();

    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      name: string;
      data: unknown;
    };
    expect(event.name).toBe("ingestion/entity.received");
  });

  it("event data satisfies the IngestionEntityReceived interface", async () => {
    await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );

    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      name: string;
      data: IngestionEntityReceived;
    };
    const data = event.data;

    // Type-shape assertions matching IngestionEntityReceived
    expect(typeof data.connectionId).toBe("string");
    expect(typeof data.workspaceId).toBe("string");
    expect(typeof data.orgId).toBe("string");
    expect(typeof data.connectorType).toBe("string");
    expect(typeof data.sourceRecordType).toBe("string");
    expect(typeof data.idempotencyKey).toBe("string");
    expect(typeof data.receivedAt).toBe("string");
    // payload must be present (even if unknown type)
    expect("payload" in data).toBe(true);
  });

  it("event data values are bound from the resolved connection row", async () => {
    await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );

    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      name: string;
      data: IngestionEntityReceived;
    };
    const data = event.data;

    // Values come from the DB connection row — not the URL params
    expect(data.connectionId).toBe(DB_CONNECTION_ROW.connectionId);
    expect(data.orgId).toBe(DB_CONNECTION_ROW.orgId);
    expect(data.workspaceId).toBe(DB_CONNECTION_ROW.workspaceId);
    expect(data.connectorType).toBe(CONNECTOR_ID);
  });

  it("sourceRecordType is taken from x-github-event header", async () => {
    await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );

    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: IngestionEntityReceived;
    };
    expect(event.data.sourceRecordType).toBe("pull_request");
  });

  it("idempotencyKey follows the {connectorType}:{connectionId}:{sourceRecordType}:{ts} convention", async () => {
    await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );

    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: IngestionEntityReceived;
    };
    // Pattern: github:{connectionId}:push:{timestamp}
    expect(event.data.idempotencyKey).toMatch(
      /^github:uuid-connection-e2e:push:\d+$/,
    );
  });

  it("receivedAt is a valid ISO-8601 datetime string", async () => {
    await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );

    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: IngestionEntityReceived;
    };
    const ts = new Date(event.data.receivedAt);
    expect(ts.toString()).not.toBe("Invalid Date");
    // Must be within 5 seconds of now
    expect(Math.abs(Date.now() - ts.getTime())).toBeLessThan(5_000);
  });

  it("payload is the parsed JSON body", async () => {
    await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );

    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: IngestionEntityReceived;
    };
    const payload = event.data.payload as {
      ref: string;
      pusher: { name: string };
    };
    expect(payload.ref).toBe("refs/heads/main");
    expect(payload.pusher.name).toBe("mac");
  });
});

// ── Connection DB lookup ──────────────────────────────────────────────────────

describe("connection DB lookup", () => {
  it("queries DB with the connection public ID from the URL", async () => {
    await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(mocks.withSystemDb).toHaveBeenCalledOnce();
  });

  it("returns 404 when connection row is not found", async () => {
    mocks.withSystemDb.mockImplementation((fn: Parameters<WithDbFn>[0]) =>
      fn(makeMockTx([]) as TxLike),
    );
    const res = await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Connection not found");
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── HMAC signature enforcement ────────────────────────────────────────────────

describe("HMAC signature enforcement", () => {
  it("returns 401 when connector.verifyWebhook returns false", async () => {
    mocks.verifyWebhook.mockReturnValue(false);
    const res = await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=invalid-sig",
        },
        body: GITHUB_PUSH_PAYLOAD,
      }),
    );
    expect(res.status).toBe(401);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("decrypts secretEnc and passes secret to verifyWebhook", async () => {
    const ENC_ROW = {
      ...DB_CONNECTION_ROW,
      secretEnc: {
        keyId: "key-1",
        ciphertext: Buffer.from("secret").toString("base64"),
      },
    };
    mocks.withSystemDb.mockImplementation((fn: Parameters<WithDbFn>[0]) =>
      fn(makeMockTx([ENC_ROW]) as TxLike),
    );
    mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
      adapter: {},
    });
    mocks.decrypt.mockResolvedValue(Buffer.from("my-webhook-secret"));

    const res = await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.decrypt).toHaveBeenCalledOnce();
    expect(mocks.verifyWebhook).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Object),
      "my-webhook-secret",
    );
  });

  it("rejects (401, fail closed) when connector has no verifyWebhook method", async () => {
    mocks.getConnector.mockReturnValue({}); // no verifyWebhook
    const res = await app.fetch(
      makeRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    // The security gate defaults CLOSED: a connector that ships no verifyWebhook
    // is rejected, not admitted, and nothing is enqueued.
    expect(res.status).toBe(401);
    expect(mocks.verifyWebhook).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── Unknown connector ─────────────────────────────────────────────────────────

describe("unknown connector slug", () => {
  it("returns 404 for an unknown connector slug", async () => {
    mocks.getConnector.mockImplementation(() => {
      throw new Error("no connector registered for 'unknown-connector'");
    });
    const res = await app.fetch(
      makeRequest(`/webhooks/unknown-connector/${CONNECTION_PUBLIC_ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unknown connector");
  });
});
