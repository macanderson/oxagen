/**
 * Unit tests for POST /v1/auth/cli/token (auth.cli.token route).
 *
 * Tests the route directly (no full app import) to avoid needing to stub the
 * auth middleware — this endpoint is public and has no auth dependency.
 *
 * Mocked boundaries:
 *   - @oxagen/auth/cli-auth  — consumeCliAuthCode, verifyPkceS256
 *   - @oxagen/database        — withSystemDb, schema
 *   - @oxagen/database/security — emitSecurityEvent
 *   - @oxagen/handlers        — generateApiKey
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock wiring (vi.hoisted keeps refs stable across dynamic imports) ────────

const TX_INSERT_VALUES = vi.fn().mockResolvedValue(undefined);
const TX_INSERT = vi.fn().mockReturnValue({ values: TX_INSERT_VALUES });
const FAKE_TX = { insert: TX_INSERT };

const mocks = vi.hoisted(() => ({
  consumeCliAuthCode: vi.fn(),
  verifyPkceS256: vi.fn(),
  withSystemDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  generateApiKey: vi.fn(),
}));

vi.mock("@oxagen/auth/cli-auth", () => ({
  consumeCliAuthCode: mocks.consumeCliAuthCode,
  verifyPkceS256: mocks.verifyPkceS256,
}));

vi.mock("@oxagen/database", () => ({
  schema: { apiKeys: Symbol("apiKeys") },
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

vi.mock("@oxagen/handlers", () => ({
  generateApiKey: mocks.generateApiKey,
}));

// ── Import AFTER mocks are declared ─────────────────────────────────────────

import { authCliTokenRoute } from "./auth.cli.token";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const VALID_CODE_DATA = {
  userId: "user-abc",
  orgId: "org-abc",
  workspaceId: "ws-abc",
  orgSlug: "acme",
  workspaceSlug: "main",
  codeChallenge: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  redirectUri: "http://127.0.0.1:51234/callback",
  label: "Mac's MacBook Pro",
};

const VALID_BODY = {
  code: "abc123code",
  code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-abcdef",
  redirect_uri: "http://127.0.0.1:51234/callback",
};

const RAW_KEY = "ox_testrawkey_abcdefghijklmnop";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  TX_INSERT.mockClear();
  TX_INSERT_VALUES.mockClear();

  // Default: everything succeeds
  mocks.consumeCliAuthCode.mockResolvedValue(VALID_CODE_DATA);
  mocks.verifyPkceS256.mockReturnValue(true);
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: typeof FAKE_TX) => Promise<void>) => fn(FAKE_TX),
  );
  mocks.generateApiKey.mockReturnValue({
    rawKey: RAW_KEY,
    keyPrefix: "ox_testrawke",
    keyHash: "sha256hexhash",
  });
  TX_INSERT_VALUES.mockResolvedValue(undefined);
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("POST /token — happy path", () => {
  it("returns 200 with token, orgSlug, workspaceSlug", async () => {
    const res = await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.token).toBe(RAW_KEY);
    expect(body.orgSlug).toBe("acme");
    expect(body.workspaceSlug).toBe("main");
  });

  it("calls consumeCliAuthCode with the code and a numeric timestamp", async () => {
    await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(mocks.consumeCliAuthCode).toHaveBeenCalledOnce();
    const [calledCode, calledNow] = mocks.consumeCliAuthCode.mock.calls[0] as [
      string,
      number,
    ];
    expect(calledCode).toBe(VALID_BODY.code);
    expect(typeof calledNow).toBe("number");
    expect(calledNow).toBeGreaterThan(0);
  });

  it("calls verifyPkceS256 with code_verifier and stored codeChallenge", async () => {
    await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(mocks.verifyPkceS256).toHaveBeenCalledOnce();
    expect(mocks.verifyPkceS256).toHaveBeenCalledWith(
      VALID_BODY.code_verifier,
      VALID_CODE_DATA.codeChallenge,
    );
  });

  it("inserts API key row via withSystemDb with correct fields", async () => {
    await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(mocks.withSystemDb).toHaveBeenCalledOnce();
    expect(TX_INSERT_VALUES).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: VALID_CODE_DATA.orgId,
        workspaceId: VALID_CODE_DATA.workspaceId,
        keyPrefix: "ox_testrawke",
        keyHash: "sha256hexhash",
        name: VALID_CODE_DATA.label,
        scope: {},
        createdByUserId: VALID_CODE_DATA.userId,
        updatedByUserId: VALID_CODE_DATA.userId,
      }),
    );
  });

  it("emits api_key.created security event", async () => {
    await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(mocks.emitSecurityEvent).toHaveBeenCalledOnce();
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "api_key.created",
        actorUserId: VALID_CODE_DATA.userId,
        orgId: VALID_CODE_DATA.orgId,
        workspaceId: null,
        capability: "create_api_key",
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    );
  });

  it("response body does NOT contain the code or code_verifier", async () => {
    const res = await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    const text = await res.text();
    expect(text).not.toContain(VALID_BODY.code);
    expect(text).not.toContain(VALID_BODY.code_verifier);
  });
});

// ── Invalid / expired code ────────────────────────────────────────────────────

describe("POST /token — invalid or expired code (consumeCliAuthCode returns null)", () => {
  beforeEach(() => {
    mocks.consumeCliAuthCode.mockResolvedValue(null);
  });

  it("returns 400 invalid_grant", async () => {
    const res = await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toBe(
      "Authorization code is invalid or expired",
    );
  });

  it("does NOT insert a DB row or emit an event", async () => {
    await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

// ── Redirect URI mismatch ─────────────────────────────────────────────────────

describe("POST /token — redirect_uri mismatch", () => {
  it("returns 400 invalid_grant when redirect_uri doesn't match stored value", async () => {
    const res = await authCliTokenRoute.fetch(
      makeRequest({
        ...VALID_BODY,
        redirect_uri: "http://127.0.0.1:9999/callback",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_grant");
  });

  it("does NOT insert a DB row or emit an event on mismatch", async () => {
    await authCliTokenRoute.fetch(
      makeRequest({
        ...VALID_BODY,
        redirect_uri: "http://127.0.0.1:9999/callback",
      }),
    );
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

// ── PKCE failure ──────────────────────────────────────────────────────────────

describe("POST /token — PKCE verification fails", () => {
  beforeEach(() => {
    mocks.verifyPkceS256.mockReturnValue(false);
  });

  it("returns 400 invalid_grant when PKCE verifier is wrong", async () => {
    const res = await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_grant");
  });

  it("does NOT insert a DB row or emit an event on PKCE failure", async () => {
    await authCliTokenRoute.fetch(makeRequest(VALID_BODY));
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });
});

// ── Bad request body ──────────────────────────────────────────────────────────

describe("POST /token — invalid request body", () => {
  it("returns 400 invalid_request for missing code field", async () => {
    const res = await authCliTokenRoute.fetch(
      makeRequest({
        code_verifier: VALID_BODY.code_verifier,
        redirect_uri: VALID_BODY.redirect_uri,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request for missing code_verifier", async () => {
    const res = await authCliTokenRoute.fetch(
      makeRequest({
        code: VALID_BODY.code,
        redirect_uri: VALID_BODY.redirect_uri,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request for missing redirect_uri", async () => {
    const res = await authCliTokenRoute.fetch(
      makeRequest({
        code: VALID_BODY.code,
        code_verifier: VALID_BODY.code_verifier,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request for empty body fields", async () => {
    const res = await authCliTokenRoute.fetch(
      makeRequest({ code: "", code_verifier: "", redirect_uri: "" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_request");
  });

  it("does NOT call consumeCliAuthCode when body is invalid", async () => {
    await authCliTokenRoute.fetch(makeRequest({}));
    expect(mocks.consumeCliAuthCode).not.toHaveBeenCalled();
  });
});
