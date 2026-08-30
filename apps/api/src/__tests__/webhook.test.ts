/**
 * Unit tests for src/routes/v1/webhook.ts
 *
 * Covers:
 * - MS Graph lifecycle validation (validationToken echo)
 * - Unknown connector → 404
 * - Connection not found → 404
 * - Webhook signature invalid → 401
 * - Happy path, no secretEnc → 200 {received:true}
 * - Happy path, with secretEnc (decrypt called) → 200
 * - Invalid JSON payload treated as raw string (no error)
 * - sourceRecordType resolved from x-github-event header
 * - sourceRecordType resolved from x-linear-event header
 * - sourceRecordType falls back to body "type" field
 * - sourceRecordType falls back to "event" when nothing matches
 * - inngest.send receives correct event shape
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  // Auth (required by app middleware)
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  // Billing (required by app)
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
  // DB
  withSystemDb: vi.fn(),
  // Inngest
  inngestSend: vi.fn(),
  // Ingestion
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

// Mock the full package to prevent function-file module-init calls to
// inngest.createFunction (which happen at top-level in each function file).
vi.mock("@oxagen/inngest-functions", () => ({
  inngest: { send: mocks.inngestSend, createFunction: vi.fn() },
  functions: [],
}));
// Also mock the /client sub-path used directly by the webhook route.
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

/**
 * Build a drizzle-style chainable query mock that resolves with `rows`.
 * Covers the withSystemDb callback (otherwise those lines are dead code in tests).
 */
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
const CONNECTION_PUBLIC_ID = "con_TEST123";
const BASE_PATH = `/webhooks/${CONNECTOR_ID}/${CONNECTION_PUBLIC_ID}`;

const DEFAULT_ROW = {
  connectionId: "uuid-connection-1",
  orgId: "org-test",
  workspaceId: "ws-test",
  status: "active",
  secretEnc: null,
};

function makePost(
  body: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return makeRequest(BASE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: valid connector that passes verification
  mocks.getConnector.mockReturnValue({ verifyWebhook: mocks.verifyWebhook });
  mocks.verifyWebhook.mockReturnValue(true);
  // Default: one connection row, no HMAC secret.
  // Call through so the drizzle query body inside the callback is exercised.
  mocks.withSystemDb.mockImplementation((fn: Parameters<WithDbFn>[0]) =>
    fn(makeMockTx([DEFAULT_ROW]) as TxLike),
  );
  // Default: inngest sends successfully
  mocks.inngestSend.mockResolvedValue({});
});

// ── MS Graph lifecycle validation ─────────────────────────────────────────────

describe("MS Graph lifecycle validation", () => {
  it("echoes validationToken back as text/plain with 200", async () => {
    const res = await app.fetch(
      makeRequest(`${BASE_PATH}?validationToken=abc123`, {
        method: "POST",
        body: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toBe("abc123");
  });

  it("skips DB and inngest for validation requests", async () => {
    await app.fetch(
      makeRequest(`${BASE_PATH}?validationToken=xyz`, {
        method: "POST",
        body: "",
      }),
    );
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── Unknown connector ─────────────────────────────────────────────────────────

describe("unknown connector", () => {
  it("returns 404 when getConnector throws", async () => {
    mocks.getConnector.mockImplementation(() => {
      throw new Error("not found");
    });
    const res = await app.fetch(makePost("{}"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Unknown connector");
  });
});

// ── Connection not found ──────────────────────────────────────────────────────

describe("connection not found", () => {
  it("returns 404 when DB returns empty rows", async () => {
    mocks.withSystemDb.mockImplementation((fn: Parameters<WithDbFn>[0]) =>
      fn(makeMockTx([]) as TxLike),
    );
    const res = await app.fetch(makePost("{}"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Connection not found");
  });
});

// ── Signature verification ────────────────────────────────────────────────────

describe("signature verification", () => {
  it("returns 401 when verifyWebhook returns false", async () => {
    mocks.verifyWebhook.mockReturnValue(false);
    const res = await app.fetch(makePost("{}"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Webhook signature invalid");
  });

  it("passes null secret to verifyWebhook when no secretEnc", async () => {
    const res = await app.fetch(makePost("{}"));
    expect(res.status).toBe(200);
    expect(mocks.verifyWebhook).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Object),
      null,
    );
  });

  it("rejects with 401 (fail closed) when connector has no verifyWebhook", async () => {
    // A webhook-delivery connector that ships no verifyWebhook is incomplete /
    // misconfigured. The security gate must default CLOSED — never admit the
    // payload unverified into the ingestion pipeline.
    mocks.getConnector.mockReturnValue({});
    const res = await app.fetch(makePost("{}"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Webhook verification unavailable");
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── Happy path — no secretEnc ─────────────────────────────────────────────────

describe("happy path — no secretEnc", () => {
  it("returns 200 {received: true}", async () => {
    const res = await app.fetch(makePost('{"type":"push"}'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });

  it("sends ingestion/entity.received event to inngest", async () => {
    await app.fetch(makePost('{"type":"push"}'));
    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    const event = mocks.inngestSend.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(event.name).toBe("ingestion/entity.received");
  });

  it("event data includes connectionId, orgId, workspaceId, connectorType", async () => {
    await app.fetch(makePost("{}"));
    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(event.data.connectionId).toBe(DEFAULT_ROW.connectionId);
    expect(event.data.orgId).toBe(DEFAULT_ROW.orgId);
    expect(event.data.workspaceId).toBe(DEFAULT_ROW.workspaceId);
    expect(event.data.connectorType).toBe(CONNECTOR_ID);
  });

  it("does not call decrypt when secretEnc is null", async () => {
    await app.fetch(makePost("{}"));
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.resolveIngestionCryptoAdapterForKeyId).not.toHaveBeenCalled();
  });
});

// ── Happy path — with secretEnc ───────────────────────────────────────────────

describe("happy path — with secretEnc (HMAC decryption)", () => {
  const ENC_ROW = {
    ...DEFAULT_ROW,
    secretEnc: {
      keyId: "key-1",
      ciphertext: Buffer.from("encrypted").toString("base64"),
    },
  };

  beforeEach(() => {
    mocks.withSystemDb.mockImplementation((fn: Parameters<WithDbFn>[0]) =>
      fn(makeMockTx([ENC_ROW]) as TxLike),
    );
    mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValue({
      adapter: {},
    });
    mocks.decrypt.mockResolvedValue(Buffer.from("my-webhook-secret"));
  });

  it("returns 200", async () => {
    const res = await app.fetch(makePost("{}"));
    expect(res.status).toBe(200);
  });

  it("decrypts the secretEnc and passes the secret to verifyWebhook", async () => {
    await app.fetch(makePost("{}"));
    expect(mocks.resolveIngestionCryptoAdapterForKeyId).toHaveBeenCalledOnce();
    expect(mocks.decrypt).toHaveBeenCalledOnce();
    expect(mocks.verifyWebhook).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Object),
      "my-webhook-secret",
    );
  });

  it("fails closed with 500 when decrypt throws (key-management failure)", async () => {
    // A stored secret that cannot be decrypted is a key-management failure
    // (missing key, corrupted ciphertext). Proceeding without it would degrade
    // the gate to unauthenticated for connectors that treat a null secret as
    // "no secret configured". Reject and never verify or enqueue.
    mocks.decrypt.mockRejectedValue(new Error("KMS error"));
    const res = await app.fetch(makePost("{}"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Webhook secret unavailable");
    expect(mocks.verifyWebhook).not.toHaveBeenCalled();
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── sourceRecordType resolution ───────────────────────────────────────────────

describe("sourceRecordType resolution", () => {
  it("uses x-github-event header when present", async () => {
    await app.fetch(makePost("{}", { "x-github-event": "pull_request" }));
    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(event.data.sourceRecordType).toBe("pull_request");
  });

  it("uses x-linear-event header when present", async () => {
    await app.fetch(makePost("{}", { "x-linear-event": "Issue" }));
    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(event.data.sourceRecordType).toBe("Issue");
  });

  it("falls back to body type field when no event headers", async () => {
    await app.fetch(makePost('{"type":"event_callback"}'));
    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(event.data.sourceRecordType).toBe("event_callback");
  });

  it("falls back to 'event' when no headers or body type", async () => {
    await app.fetch(makePost("{}"));
    const event = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(event.data.sourceRecordType).toBe("event");
  });
});

// ── Invalid JSON payload ───────────────────────────────────────────────────────

describe("invalid JSON payload", () => {
  it("treats non-JSON body as raw string payload and returns 200", async () => {
    const res = await app.fetch(
      makeRequest(BASE_PATH, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });
});
