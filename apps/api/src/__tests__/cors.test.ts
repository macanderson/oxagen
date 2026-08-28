/**
 * Unit tests for src/middleware/cors.ts (mounted globally in app.ts).
 *
 * Covers:
 * - Preflight OPTIONS from an allowed origin → ACAO echoes origin,
 *   credentials allowed, methods/headers advertised, no auth required
 * - Preflight from a disallowed origin → no ACAO header (browser blocks)
 * - Actual (non-preflight) request carries ACAO + allow-credentials
 * - APP_URL / NEXT_PUBLIC_APP_URL env origins are honored, trailing
 *   slash normalized
 *
 * The browser "Failed to fetch" failure mode this guards against: app at
 * localhost:3000 fetching the API at localhost:4000 with credentials —
 * the GitHub connection wizard's POST /connections preflight died here.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  // OXA-1753: /health calls this; mock returns false so the email-transport
  // gate is inert for tests that hit /health for an unrelated reason (cors).
  isEmailVerificationRequired: vi.fn().mockReturnValue(false),
}));

vi.mock("@oxagen/notifications", () => ({
  isEmailTransportConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: vi.fn(),
  clearHandlersForTests: vi.fn(),
}));

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
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

const LOCAL_APP_ORIGIN = "http://localhost:3000";

function preflight(path: string, origin: string, method = "POST"): Request {
  return makeRequest(path, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "content-type",
    },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("CORS preflight (OPTIONS)", () => {
  it("echoes an allowed dev origin and permits credentials", async () => {
    const res = await app.fetch(
      preflight("/v1/acme/main/connections", LOCAL_APP_ORIGIN),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      LOCAL_APP_ORIGIN,
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(
      res.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("content-type");
  });

  it("does not require auth — preflights carry no credentials", async () => {
    // No cookie, no Authorization header: must still succeed.
    const res = await app.fetch(
      preflight(
        "/v1/acme/main/connections/github/auth-url",
        LOCAL_APP_ORIGIN,
        "GET",
      ),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      LOCAL_APP_ORIGIN,
    );
  });

  it("sends no allow-origin header for an unknown origin", async () => {
    const res = await app.fetch(
      preflight("/v1/acme/main/connections", "https://evil.example.com"),
    );
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows the deployed app origin from APP_URL, normalizing a trailing slash", async () => {
    vi.stubEnv("APP_URL", "https://app.oxagen.sh/");
    const res = await app.fetch(
      preflight("/v1/acme/main/connections", "https://app.oxagen.sh"),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.oxagen.sh",
    );
  });

  it("allows the deployed app origin from NEXT_PUBLIC_APP_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.oxagen.ai");
    const res = await app.fetch(
      preflight("/v1/acme/main/connections", "https://app.oxagen.ai"),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.oxagen.ai",
    );
  });
});

describe("CORS in production (localhost must NOT be trusted)", () => {
  it("refuses localhost:3000 when VERCEL_ENV=production", async () => {
    // A realistic production env: APP_URL is the deployed domain, not localhost.
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("APP_URL", "https://app.oxagen.sh");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.oxagen.sh");
    const res = await app.fetch(
      preflight("/v1/acme/main/connections", LOCAL_APP_ORIGIN),
    );
    // No ACAO granted → the browser blocks the credentialed cross-origin call.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("still trusts the configured APP_URL origin in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("APP_URL", "https://app.oxagen.sh");
    const res = await app.fetch(
      preflight("/v1/acme/main/connections", "https://app.oxagen.sh"),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.oxagen.sh",
    );
  });
});

describe("CORS on actual requests", () => {
  it("adds allow-origin + allow-credentials to a cross-origin GET", async () => {
    const res = await app.fetch(
      makeRequest("/health", { headers: { origin: LOCAL_APP_ORIGIN } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      LOCAL_APP_ORIGIN,
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("adds no CORS headers for a disallowed origin", async () => {
    const res = await app.fetch(
      makeRequest("/health", {
        headers: { origin: "https://evil.example.com" },
      }),
    );
    // Route still answers (CORS is browser-enforced) but no ACAO is granted.
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("leaves same-origin requests (no Origin header) untouched", async () => {
    const res = await app.fetch(makeRequest("/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
