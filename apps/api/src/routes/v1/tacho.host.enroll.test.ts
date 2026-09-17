// POST /v1/tacho/enroll through the whole app (#2967): the route's own
// pre-auth ceilings, and its separation from the /v1/tacho/* ceilings that
// every caller with no Authorization header shares. The counter store is a
// per-key fake behind withSystemDb, so each bucket counts independently.
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

vi.mock("../../middleware/logger", () => ({
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

import { app } from "../../app";

const counts = new Map<string, number>();

function enrollBody(token: string) {
  return {
    token,
    hostname: "mbp.local",
    osUser: "dev",
    platform: "darwin",
    devicePublicKey: `ed25519:${"A".repeat(44)}`,
    harnesses: ["claude-code"],
  };
}

async function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.7",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Pin the limiter's clock to its own minute so a test never shares a window (or a cached denial) with another. */
function atMinute(n: number): void {
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 15, 12, n, 1));
}

beforeEach(() => {
  vi.clearAllMocks();
  counts.clear();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  mocks.parseSessionCookie.mockReturnValue(null);
  // The limiter's upsert: the bucket key is the first raw parameter of the query.
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: vi.fn(async (query: { queryChunks: unknown[] }) => {
          const key = query.queryChunks.find(
            (chunk): chunk is string => typeof chunk === "string",
          );
          const count = (counts.get(key ?? "") ?? 0) + 1;
          counts.set(key ?? "", count);
          return [{ count }];
        }),
      }),
  );
  mocks.invoke.mockResolvedValue({ hostEnrollmentId: "tch_0123456789" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/tacho/enroll rate limits", () => {
  it("still enrols after 121 unauthenticated calls to another /v1/tacho path exhaust the shared credential bucket", async () => {
    atMinute(1);
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      statuses.push((await request("/v1/tacho/events", {})).status);
    }
    expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
    expect(statuses[120]).toBe(429);

    const enrolled = await request(
      "/v1/tacho/enroll",
      enrollBody("oxe_1time_0123456789abcdefghjkmnpqrs"),
    );
    expect(enrolled.status).toBe(201);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "enroll_host",
      expect.objectContaining({
        token: "oxe_1time_0123456789abcdefghjkmnpqrs",
      }),
      expect.anything(),
      { surface: "api" },
    );
  });

  it("refuses a sixth presentation of one token in a minute and lets another token through", async () => {
    atMinute(3);
    const token = "oxe_1time_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await request("/v1/tacho/enroll", enrollBody(token))).status,
      );
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect(mocks.invoke).toHaveBeenCalledTimes(5);

    const other = await request(
      "/v1/tacho/enroll",
      enrollBody("oxe_1time_bbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );
    expect(other.status).toBe(201);
    expect([...counts.keys()].some((key) => key.includes("oxe_1time_"))).toBe(
      false,
    );
  });

  it("caps one client address across tokens", async () => {
    // The per-address ceiling is enforced only where the deployment declares
    // its proxy depth; undeclared, it skips rather than pooling every caller
    // into one bucket that any of them could exhaust for the rest.
    vi.stubEnv("TRUSTED_PROXY_HOP_COUNT", "1");
    atMinute(5);
    // The address has used its 120 presentations this minute.
    counts.set("tacho-enroll-ip:ip:198.51.100.9", 120);
    const refused = await request(
      "/v1/tacho/enroll",
      enrollBody("oxe_1time_cccccccccccccccccccccccccc"),
      { "x-forwarded-for": "198.51.100.9" },
    );
    expect(refused.status).toBe(429);
    const elsewhere = await request(
      "/v1/tacho/enroll",
      enrollBody("oxe_1time_cccccccccccccccccccccccccc"),
      { "x-forwarded-for": "198.51.100.10" },
    );
    expect(elsewhere.status).toBe(201);
  });
});
