/**
 * Unit tests for src/routes/health.ts
 *
 * Covers:
 * - GET /health → 200 {status:"ok"}
 * - Works with no auth
 * - Works with an Authorization header (no auth gate on public routes)
 *
 * Note: x-request-id header behaviour is covered in logger.test.ts, which
 * exercises the real requestLogger; here requestLogger is mocked to a
 * pass-through so it is intentionally not asserted.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(),
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    verifyStripeSignature: vi.fn(),
    processStripeEvent: vi.fn(),
    bootstrapBillingRuntime: vi.fn(),
  };
});

vi.mock("@oxagen/handlers", () => ({
  serveFile: vi.fn(),
  FileNotFoundError: class FileNotFoundError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileNotFoundError"; }
  },
  FileForbiddenError: class FileForbiddenError extends Error {
    constructor(msg?: string) { super(msg); this.name = "FileForbiddenError"; }
  },
}));

vi.mock("../middleware/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  requestLogger: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { app } from "../app";
import { makeRequest } from "./_helpers";

describe("GET /health", () => {
  it("returns 200", async () => {
    const res = await app.fetch(makeRequest("/health"));
    expect(res.status).toBe(200);
  });

  it("returns {status:'ok'}", async () => {
    const res = await app.fetch(makeRequest("/health"));
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("works with no Authorization header (public route)", async () => {
    const res = await app.fetch(makeRequest("/health"));
    expect(res.status).toBe(200);
  });

  it("works even when Authorization header is present (not gated)", async () => {
    const res = await app.fetch(
      makeRequest("/health", {
        headers: { authorization: "Bearer some-token" },
      }),
    );
    // Health is not behind auth middleware — any auth header is ignored
    expect(res.status).toBe(200);
  });
});
