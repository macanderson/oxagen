/**
 * GET /v1/run-exports/download sits behind an IP-keyed pre-auth ceiling in
 * app.ts, the way /v1/run-ingest does. The route has no session, so the
 * limiter is the one thing between a public URL and a bundle stream. These
 * cases hold the mount: a counter over the ceiling answers 429 before the
 * route runs, and a counter under it reaches the route, whose bad-token
 * answer is a 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveApiKey: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveSession: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withSystemDb: mocks.withSystemDb,
}));

vi.mock("@oxagen/auth", () => ({
  parseSessionCookie: mocks.parseSessionCookie,
  resolveApiKey: mocks.resolveApiKey,
  resolveOrgScope: mocks.resolveOrgScope,
  resolveSession: mocks.resolveSession,
  resolveWorkspaceScope: mocks.resolveWorkspaceScope,
}));

vi.mock("@oxagen/oxagen/kernel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen/kernel")>()),
  invoke: mocks.invoke,
}));

vi.mock("@oxagen/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/billing")>()),
  bootstrapBillingRuntime: vi.fn(),
  processStripeEvent: vi.fn(),
  verifyStripeSignature: vi.fn(),
}));

vi.mock("@oxagen/handlers", () => ({
  FileForbiddenError: class FileForbiddenError extends Error {},
  FileNotFoundError: class FileNotFoundError extends Error {},
  serveFile: vi.fn(),
}));

vi.mock("../middleware/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  requestLogger: vi.fn(
    async (
      c: { set: (key: "requestId", value: string) => void },
      next: () => Promise<void>,
    ) => {
      c.set("requestId", "33333333-3333-4333-8333-333333333333");
      await next();
    },
  ),
}));

import { app } from "../app";
import { __resetTrustedProxyHopsForTests } from "../lib/context";

const PATH = "/v1/run-exports/download?token=not-a-real-token";

/** Count the limiter's Postgres upsert as `count`, recording the bucket keys. */
function countAs(count: number): string[] {
  const keys: string[] = [];
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: vi.fn().mockImplementation(async (query: unknown) => {
          const key = (query as { queryChunks?: unknown[] }).queryChunks?.at(1);
          if (typeof key === "string") keys.push(key);
          return [{ count }];
        }),
      }),
  );
  return keys;
}

/**
 * One address per case: the limiter remembers a denied bucket for the rest
 * of its window in-process, so a second case on the same address would read
 * the first case's 429 rather than its own counter.
 */
async function get(clientIp: string): Promise<Response> {
  return await app.fetch(
    new Request(`http://localhost${PATH}`, {
      // Vercel's own header is the one an attributable caller carries there;
      // an unattributable request skips the pre-auth counter by design.
      headers: { "x-vercel-forwarded-for": clientIp },
    }),
  );
}

beforeEach(() => {
  __resetTrustedProxyHopsForTests();
  vi.clearAllMocks();
  vi.stubEnv("VERCEL", "1");
  // The route verifies the token against the export signing secret before
  // it reads anything, and a bad token is its 404. Without a secret it
  // throws on the read and the 404 becomes a 500 that says nothing about
  // the limiter.
  vi.stubEnv("AUDIT_EXPORT_SIGNING_SECRET", "a-test-secret-of-some-length");
  mocks.parseSessionCookie.mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /v1/run-exports/download behind the pre-auth IP ceiling", () => {
  it("answers 429 from the IP bucket before the route runs", async () => {
    const keys = countAs(301);

    const response = await get("203.0.113.250");

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(keys).toEqual(["run-export-preauth-ip:ip:203.0.113.250"]);
  });

  it("reaches the route under the ceiling, whose bad-token answer is 404", async () => {
    const keys = countAs(1);

    const response = await get("203.0.113.251");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(keys).toEqual(["run-export-preauth-ip:ip:203.0.113.251"]);
  });
});
