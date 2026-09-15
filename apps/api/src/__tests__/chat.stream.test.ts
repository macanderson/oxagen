/**
 * Integration tests for POST /:org_slug/:workspace_slug/chat/stream, mounted in
 * the real Hono app so the auth guard, the org/workspace scoping, the published
 * ingress contract and the error middleware are exercised end to end.
 *
 * The order the route applies its gates is the thing this file locks in:
 * auth → body validation → `invoke("ask_assistant")`. The pre-turn credit
 * admission gate runs inside that invoke (prepareAssistantTurn,
 * @oxagen/agent), so the kernel is stubbed here to refuse the turn the way the
 * gate does, and a request that gets past validation stops at a 402 without a
 * model, Neo4j or Postgres. The gate itself is covered by
 * packages/agent/src/runtime/assistant-turn.test.ts; the streamed turn by
 * routes/v1/chat.stream.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...real, invoke: mocks.invoke };
});

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest, bearerHeader, makeApiKeyOk } from "./_helpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE = "/v1/test-org/test-ws";
const PATH = "/chat/stream";

// Mirrors CHAT_CONTENT_MAX_CHARS in the chat.message.send contract — the shared
// per-message ingress cap every chat surface enforces identically.
const CONTENT_CAP = 32_768;

function post(body: unknown, extraHeaders?: Record<string, string>): Request {
  return makeRequest(`${BASE}${PATH}`, {
    method: "POST",
    headers: {
      authorization: bearerHeader("oxk_key"),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

/** The credit gate's refusal as the turn throws it (AssistantTurnRefusedError). */
function creditRefusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

type ErrorBody = { error?: { code?: string; message?: string } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  // Refuse by default so a valid request stops before the stream opens instead
  // of running a real turn. The admitted path is covered in
  // routes/v1/chat.stream.test.ts.
  mocks.invoke.mockRejectedValue(
    creditRefusal(
      "insufficient_credits",
      "Insufficient credits: your balance is empty.",
    ),
  );
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe("chat stream: auth guard", () => {
  it("returns 401 when no auth header", async () => {
    const req = makeRequest(`${BASE}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi" }),
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when API key is invalid", async () => {
    mocks.resolveApiKey.mockResolvedValue({ ok: false, kind: "invalid" });
    const res = await app.fetch(post({ content: "hi" }));
    expect(res.status).toBe(401);
  });

  // Auth runs FIRST: an unauthorized caller never reaches the turn, so it can
  // never learn anything about the org's balance from this endpoint.
  it("rejects an unauthorized caller before the turn is invoked", async () => {
    mocks.resolveApiKey.mockResolvedValue({ ok: false, kind: "invalid" });
    const res = await app.fetch(post({ content: "hi" }));
    expect(res.status).toBe(401);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── Body validation ───────────────────────────────────────────────────────────

describe("chat stream: body validation", () => {
  it("returns 400 for invalid JSON", async () => {
    const req = makeRequest(`${BASE}${PATH}`, {
      method: "POST",
      headers: {
        authorization: bearerHeader("oxk_key"),
        "content-type": "application/json",
      },
      body: "not-json",
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is missing", async () => {
    const res = await app.fetch(post({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when content is empty string", async () => {
    const res = await app.fetch(post({ content: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a nonsense budget override (enabled with null limit)", async () => {
    const res = await app.fetch(
      post({
        content: "Hello",
        budget: {
          enabled: true,
          limitUsd: null,
          mode: "enforce",
          graceOveragePct: 0.25,
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  // Validation runs BEFORE the turn: a caller sending a bad body gets the
  // specific 400 that tells them what is wrong with it, and is not billed for
  // the attempt.
  it("rejects a malformed body with 400 before the turn is invoked", async () => {
    const res = await app.fetch(post({ content: "" }));
    expect(res.status).toBe(400);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

// ── Content ingress cap ───────────────────────────────────────────────────────

describe("chat stream: content ingress cap", () => {
  it("returns 400 when content exceeds the shared CHAT_CONTENT_MAX_CHARS cap", async () => {
    const res = await app.fetch(post({ content: "x".repeat(CONTENT_CAP + 1) }));
    expect(res.status).toBe(400);
  });

  it("accepts content exactly at the cap (past validation, into the credit gate)", async () => {
    const res = await app.fetch(post({ content: "x".repeat(CONTENT_CAP) }));
    expect(res.status).toBe(402);
  });
});

// ── Pre-turn credit admission gate ───────────────────────────────────────────

describe("chat stream: credit admission gate", () => {
  it("answers 402 with the billing code when the org cannot spend", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("insufficient_credits");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls[0]?.[0]).toBe("ask_assistant");
  });

  it("answers JSON, not an SSE stream, when it refuses the turn", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("answers 402 for a suspended org", async () => {
    mocks.invoke.mockRejectedValue(
      creditRefusal("billing_suspended", "Billing suspended"),
    );
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.status).toBe(402);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("billing_suspended");
  });

  it("accepts every optional field the ingress contract still publishes", async () => {
    const res = await app.fetch(
      post({
        content: "Hello",
        conversationId: "66666666-6666-4666-8666-666666666666",
        activeServerIds: ["mcp-1"],
        tier: "balanced",
        model: "anthropic/claude-sonnet",
        effort: "low",
        budget: {
          enabled: true,
          limitUsd: 2,
          mode: "enforce",
          graceOveragePct: 0.25,
        },
      }),
    );
    // Past validation — refused by the (denying) credit gate, not by the schema.
    expect(res.status).toBe(402);
  });
});
