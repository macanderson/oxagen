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
 * Asserted by call order rather than by reading app.ts, and deliberately NOT by
 * a status code. The first version of this test read the ordering off a 503:
 * with the counter store failing, the fail-closed limiter denied, so an
 * unauthenticated 503 proved the limiter ran first. That tied the proof of one
 * invariant to an unrelated policy — ADR-082 then replaced `failClosed` with
 * `degrade-to-local`, no store error denies any more, and the test failed while
 * the ordering it was guarding was still correct.
 *
 * What the ordering actually means is that the counter store is consulted for a
 * request auth has not seen yet. So that is what is asserted: `withSystemDb`
 * runs, and it runs BEFORE `resolveApiKey`. Registered below the `/v1` mount,
 * auth rejects first and the limiter is never reached, so `withSystemDb` is
 * never called at all — which is the failure this catches, under any
 * store-error policy.
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

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => {
  // CapabilityError is needed as a real class: onError does `err instanceof
  // CapabilityError`, and a mock without it throws from inside the error
  // handler, which reads as a routing failure rather than a missing export.
  const actual = await importOriginal<typeof import("@oxagen/oxagen/kernel")>();
  return {
    ...actual,
    invoke: mocks.invoke,
    clearHandlersForTests: vi.fn(),
  };
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
  // The counter store answers, so the limiter completes normally and the
  // request carries on to auth. The point here is WHEN the store is consulted,
  // not what it says.
  mocks.withSystemDb.mockResolvedValue([{ count: 1 }]);
  mocks.resolveApiKey.mockResolvedValue(null);
  mocks.resolveSession.mockResolvedValue(null);
  mocks.parseSessionCookie.mockReturnValue(null);
});

/**
 * Whether the counter store was consulted before authentication touched the
 * request.
 *
 * Compared against whichever auth seam actually ran rather than against
 * `resolveApiKey` alone: an anonymous request carries no Authorization header,
 * so auth takes the session path and `resolveApiKey` is never called. Keying on
 * it would make this pass for the wrong reason on exactly the request the
 * pre-auth ceiling exists for.
 */
function storeRanBeforeAuth(): boolean {
  const store = mocks.withSystemDb.mock.invocationCallOrder[0];
  if (store === undefined) return false;
  const auth = [
    mocks.resolveApiKey,
    mocks.resolveSession,
    mocks.parseSessionCookie,
  ]
    .flatMap((m) => m.mock.invocationCallOrder)
    .sort((a, b) => a - b)[0];
  // Auth must have run too, or this proves nothing about ordering.
  return auth !== undefined && store < auth;
}

describe("/v1/tacho/* pre-authentication ceilings", () => {
  it("counts an unauthenticated request before auth can reject it", async () => {
    await app.fetch(tachoPost());

    // The ceiling was reached at all. Registered below the `/v1` mount this is
    // zero: auth rejects an anonymous request and the limiter never runs.
    expect(mocks.withSystemDb).toHaveBeenCalled();
    expect(storeRanBeforeAuth()).toBe(true);
  });

  it("counts a malformed credential before auth can reject it", async () => {
    // The credential-stuffing case: a bad key must be counted, not just
    // rejected, or the bucket that exists to bound the attack never fills.
    await app.fetch(tachoPost({ authorization: "Bearer not-a-real-key" }));

    expect(mocks.withSystemDb).toHaveBeenCalled();
    expect(storeRanBeforeAuth()).toBe(true);
  });

  it("still counts when the store is unreachable, rather than skipping the ceiling", async () => {
    // ADR-082: a store error degrades to the per-instance limiter. The request
    // proceeds, so the only evidence the ceiling ran is that it was consulted.
    vi.clearAllMocks();
    mocks.withSystemDb.mockRejectedValue(
      new Error("counter store unavailable"),
    );
    mocks.resolveApiKey.mockResolvedValue(null);
    mocks.resolveSession.mockResolvedValue(null);
    mocks.parseSessionCookie.mockReturnValue(null);

    await app.fetch(tachoPost());

    expect(mocks.withSystemDb).toHaveBeenCalled();
    expect(storeRanBeforeAuth()).toBe(true);
  });
});
