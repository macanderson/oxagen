/**
 * The `/v1/tacho/*` credential-stuffing ceilings must run BEFORE authentication.
 *
 * They are registered with `app.use("/v1/tacho/*", …)`, and `app.route("/v1",
 * userScoped)` puts `authMiddleware` on a `/v1/*` matcher that also covers
 * `/v1/tacho/*`. Hono runs matching middleware in registration order, so the
 * limiters only see unauthenticated traffic while they are registered above
 * that mount. They were registered below it, which meant every unauthenticated
 * request was rejected by auth first and counted against no bucket at all —
 * the exact traffic the ceiling exists to bound never reached it.
 *
 * Asserted by symptom rather than by reading app.ts: with the counter store
 * failing these mounts degrade to the per-instance ceiling (ADR-082), so an
 * UNAUTHENTICATED caller that spends that ceiling is answered 429 by the
 * limiter. Wrong order and auth rejects the same request 401 long before the
 * ceiling is reached, and `resolveApiKey` is called.
 *
 * This used to probe the order with 503 `rate_limit_unavailable`, the answer
 * the fail-closed policy gave on a store error. ADR-082 removed that answer
 * because it turned one unreachable Postgres row into a total Tacho and Stella
 * ingest outage (#3167). The invariant this file exists for is unchanged — the
 * ceilings run before auth — so only the symptom it reads has moved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  invoke: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: mocks.resolveApiKey,
  resolveSession: mocks.resolveSession,
  parseSessionCookie: mocks.parseSessionCookie,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

// Spread the real module: unlike the 503 this file used to assert, a degraded
// ceiling lets requests through to auth and the error middleware, which needs
// the kernel's real `CapabilityError` to classify what auth throws.
vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return { ...actual, invoke: mocks.invoke, clearHandlersForTests: vi.fn() };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  return { ...actual, withSystemDb: mocks.withSystemDb };
});

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) =>
    next(),
  ),
}));

import { app } from "../app";
import { makeRequest } from "./_helpers";

function tachoPost(headers: Record<string, string> = {}): Request {
  return makeRequest("/v1/tacho/commands", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The counter store is down, so the pre-auth limiters degrade to their
  // per-instance ceilings rather than denying outright.
  mocks.withSystemDb.mockRejectedValue(new Error("counter store unavailable"));
  mocks.resolveApiKey.mockResolvedValue(null);
  mocks.resolveSession.mockResolvedValue(null);
  mocks.parseSessionCookie.mockReturnValue(null);
});

describe("/v1/tacho/* pre-authentication ceilings", () => {
  // The per-credential ceiling mounted on /v1/tacho/* (app.ts). An absent
  // Authorization header is still a credential to this bucket — it fingerprints
  // the empty string — so an anonymous flood is bounded by the same number.
  const PREAUTH_CREDENTIAL_MAX = 120;

  /**
   * Spend this credential's degraded ceiling, then send one more request and
   * return its response.
   *
   * `resolveApiKey` is cleared just before that last request, so what the
   * assertions read is what auth did for the request the limiter answered —
   * not for the ones it let through while the bucket still had room. Those
   * earlier requests reaching auth is expected and is the whole difference
   * from a fail-closed ceiling, which never let any of them past.
   */
  async function spendCeilingThenOneMore(
    headers: Record<string, string> = {},
  ): Promise<Response> {
    for (let i = 0; i < PREAUTH_CREDENTIAL_MAX; i += 1) {
      await app.fetch(tachoPost(headers));
    }
    mocks.resolveApiKey.mockClear();
    return app.fetch(tachoPost(headers));
  }

  it("counts an unauthenticated request before auth can reject it", async () => {
    const res = await spendCeilingThenOneMore();

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    // Auth never got a say on this one — it stopped at the ceiling.
    expect(mocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it("counts a malformed credential before auth can reject it", async () => {
    // A distinct credential, so this test spends its own bucket rather than
    // inheriting the one above: the degraded limiter is per mount, and the
    // mounts are built once when app.ts is imported.
    const res = await spendCeilingThenOneMore({
      authorization: "Bearer not-a-real-key",
    });

    expect(res.status).toBe(429);
    expect(mocks.resolveApiKey).not.toHaveBeenCalled();
  });
});
