/**
 * Unit tests for src/routes/stripe.ts
 *
 * Covers:
 * - Missing stripe-signature → 400
 * - verifyStripeSignature throws Error → 400 with that message
 * - verifyStripeSignature throws non-Error → 400 "signature verification failed"
 * - Success → 200 {received:true}
 * - Confirms it uses c.req.text() not JSON (raw body is passed through)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  verifyStripeSignature: vi.fn(),
  processStripeEvent: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
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

import { app } from "../app";
import { makeRequest } from "./_helpers";

const STRIPE_PATH = "/webhooks/stripe";

function makeStripePost(body: string, signature?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature !== undefined) {
    headers["stripe-signature"] = signature;
  }
  return makeRequest(STRIPE_PATH, {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Missing stripe-signature ─────────────────────────────────────────────────

describe("stripe webhook — missing signature", () => {
  it("missing stripe-signature header → 400", async () => {
    const res = await app.fetch(makeStripePost("{}", undefined));
    expect(res.status).toBe(400);
  });

  it("missing signature body includes 'Missing stripe-signature'", async () => {
    const res = await app.fetch(makeStripePost("{}", undefined));
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Missing stripe-signature");
  });
});

// ── verifyStripeSignature throws ─────────────────────────────────────────────

describe("stripe webhook — signature verification failure", () => {
  it("verifyStripeSignature throws Error → 400 with that error's message", async () => {
    mocks.verifyStripeSignature.mockImplementation(() => {
      throw new Error("Stripe timestamp too old");
    });
    const res = await app.fetch(makeStripePost("{}", "t=123,v1=abc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Stripe timestamp too old");
  });

  it("verifyStripeSignature throws non-Error → 400 'signature verification failed'", async () => {
    mocks.verifyStripeSignature.mockImplementation(() => {
      throw "plain string error";
    });
    const res = await app.fetch(makeStripePost("{}", "t=123,v1=abc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("signature verification failed");
  });

  it("verifyStripeSignature throws null → 400 'signature verification failed'", async () => {
    mocks.verifyStripeSignature.mockImplementation(() => {
      throw null;
    });
    const res = await app.fetch(makeStripePost("{}", "t=123,v1=abc"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("signature verification failed");
  });
});

// ── Success ──────────────────────────────────────────────────────────────────

describe("stripe webhook — success", () => {
  const fakeEvent = {
    providerEventId: "evt_test_abc",
    type: "payment_intent.succeeded",
  };

  beforeEach(() => {
    mocks.verifyStripeSignature.mockReturnValue(fakeEvent);
    mocks.processStripeEvent.mockResolvedValue({ status: "processed" });
  });

  it("returns 200 {received:true} on success", async () => {
    const res = await app.fetch(
      makeStripePost(JSON.stringify({}), "t=999,v1=sig"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { received: boolean };
    expect(body.received).toBe(true);
  });

  it("includes the status from processStripeEvent", async () => {
    const res = await app.fetch(
      makeStripePost(JSON.stringify({}), "t=999,v1=sig"),
    );
    const body = (await res.json()) as { received: boolean; status: string };
    expect(body.status).toBe("processed");
  });

  it("passes the raw text body to verifyStripeSignature (not JSON-parsed)", async () => {
    // The raw body must be passed as a string to verifyStripeSignature
    const rawBody = '{"id":"evt_raw","object":"event"}';
    await app.fetch(makeStripePost(rawBody, "t=999,v1=sig"));
    expect(mocks.verifyStripeSignature).toHaveBeenCalledWith(
      rawBody,
      "t=999,v1=sig",
    );
  });
});
