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
 * failing, the fail-closed limiter answers 503, so an UNAUTHENTICATED request
 * that comes back 503 proves the limiter ran first. Wrong order and the same
 * request comes back 401.
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

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
  clearHandlersForTests: vi.fn(),
}));

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
  // The counter store is down, so the fail-closed pre-auth limiters deny.
  mocks.withSystemDb.mockRejectedValue(new Error("counter store unavailable"));
  mocks.resolveApiKey.mockResolvedValue(null);
  mocks.resolveSession.mockResolvedValue(null);
  mocks.parseSessionCookie.mockReturnValue(null);
});

describe("/v1/tacho/* pre-authentication ceilings", () => {
  it("counts an unauthenticated request before auth can reject it", async () => {
    const res = await app.fetch(tachoPost());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "rate_limit_unavailable" });
    // Auth never got a say — the request stopped at the ceiling.
    expect(mocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it("counts a malformed credential before auth can reject it", async () => {
    const res = await app.fetch(
      tachoPost({ authorization: "Bearer not-a-real-key" }),
    );

    expect(res.status).toBe(503);
    expect(mocks.resolveApiKey).not.toHaveBeenCalled();
  });
});
