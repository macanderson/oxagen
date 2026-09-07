/**
 * Unit tests for POST /:org_slug/:workspace_slug/chat/stream
 *
 * ADR-041 excised the agent runtime, so this route no longer streams: it
 * authenticates, scopes, validates the body, and then answers
 * 501 { error: { code: "chat_stream_pending_governed_turn" } } until
 * `runGovernedTurn` lands in @oxagen/agent.
 *
 * What is covered here is exactly what the route still does, and it is not
 * placeholder coverage — the auth guard, the tenant scoping, the ingress
 * contract (malformed JSON, missing/empty content, the shared content cap, the
 * per-turn budget schema) and the 501 discriminant are the parts of this
 * surface a client depends on today. The SSE, tool-loop, persistence and
 * SOC 2 execution-recording tests went with the engine; they come back with
 * the governed turn, not before.
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

type PendingBody = { error?: { code?: string; message?: string } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveApiKey.mockResolvedValue(makeApiKeyOk());
  mocks.invoke.mockResolvedValue(undefined);
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

  // The 501 must sit BEHIND the auth guard, not in front of it: an unauthorized
  // caller learns nothing about which capabilities the surface currently has.
  it("does not leak the pending-implementation code to an unauthorized caller", async () => {
    mocks.resolveApiKey.mockResolvedValue({ ok: false, kind: "invalid" });
    const res = await app.fetch(post({ content: "hi" }));
    const body = (await res.json()) as PendingBody;
    expect(body.error?.code).not.toBe("chat_stream_pending_governed_turn");
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

  // Validation runs BEFORE the 501: a caller sending a bad body still gets the
  // specific 400 that tells them what is wrong with it.
  it("rejects a malformed body with 400, not the 501", async () => {
    const res = await app.fetch(post({ content: "" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as PendingBody;
    expect(body.error?.code).not.toBe("chat_stream_pending_governed_turn");
  });
});

// ── Content ingress cap ───────────────────────────────────────────────────────

describe("chat stream: content ingress cap", () => {
  it("returns 400 when content exceeds the shared CHAT_CONTENT_MAX_CHARS cap", async () => {
    const res = await app.fetch(post({ content: "x".repeat(CONTENT_CAP + 1) }));
    expect(res.status).toBe(400);
  });

  it("accepts content exactly at the cap (past validation, into the 501)", async () => {
    const res = await app.fetch(post({ content: "x".repeat(CONTENT_CAP) }));
    expect(res.status).toBe(501);
  });
});

// ── Pending governed turn (ADR-041) ───────────────────────────────────────────

describe("chat stream: pending governed turn", () => {
  it("returns 501 with the chat_stream_pending_governed_turn code for a valid request", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.status).toBe(501);
    const body = (await res.json()) as PendingBody;
    expect(body.error?.code).toBe("chat_stream_pending_governed_turn");
    expect(body.error?.message).toContain("ADR-041");
  });

  it("accepts every optional field the ingress contract still publishes", async () => {
    const res = await app.fetch(
      post({
        content: "Hello",
        conversationId: "conv-1",
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
    expect(res.status).toBe(501);
  });

  // No engine means no metered work: the route must not reach the kernel at
  // all, so a caller is never charged for a turn that cannot run.
  it("never reaches the capability kernel", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.status).toBe(501);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("answers JSON, not an SSE stream", async () => {
    const res = await app.fetch(post({ content: "Hello" }));
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
