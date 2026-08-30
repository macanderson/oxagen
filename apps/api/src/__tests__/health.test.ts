/**
 * Unit tests for src/routes/health.ts
 *
 * Covers:
 * - GET /health → 200 {status:"ok"} when not deployed (no email gate)
 * - GET /health → 200 when deployed AND email transport is configured
 * - GET /health → 503 {status:"degraded", checks.email_transport:"fail"}
 *   when deployed AND email transport is unconfigured (OXA-1753 gate)
 * - Works with / without an Authorization header (no auth gate on /health)
 *
 * Note: x-request-id header behaviour is covered in logger.test.ts, which
 * exercises the real requestLogger; here requestLogger is mocked to a
 * pass-through so it is intentionally not asserted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Helpers used to drive the email-gate predicate per-test. We need mutable
// fakes (not constants) because the OXA-1753 gate tests have to flip the
// answer between cases without re-importing the app.
const isEmailVerificationRequiredMock = vi.fn<() => boolean>();
const isEmailTransportConfiguredMock = vi.fn<() => boolean>();

vi.mock("@oxagen/auth", () => ({
  resolveApiKey: vi.fn(),
  resolveSession: vi.fn(),
  parseSessionCookie: vi.fn(),
  resolveOrgScope: vi.fn(),
  resolveWorkspaceScope: vi.fn(),
  isEmailVerificationRequired: () => isEmailVerificationRequiredMock(),
}));

vi.mock("@oxagen/notifications", () => ({
  isEmailTransportConfigured: () => isEmailTransportConfiguredMock(),
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

describe("GET /health", () => {
  beforeEach(() => {
    // Default: local env, no gate active (matches the historical 200 OK shape).
    isEmailVerificationRequiredMock.mockReturnValue(false);
    isEmailTransportConfiguredMock.mockReturnValue(true);
  });

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

  // -----------------------------------------------------------------------
  // OXA-1753 — email-transport gate
  //
  // Deployed envs set Better Auth's requireEmailVerification=true. If SMTP_*
  // is missing the verification email vanishes silently and no credential
  // sign-up can complete. /health must report this as 503 so Vercel /
  // uptime monitors catch the misconfig before customers do.
  // -----------------------------------------------------------------------
  describe("email-transport gate (OXA-1753)", () => {
    it("returns 200 when deployed and SMTP is configured", async () => {
      isEmailVerificationRequiredMock.mockReturnValue(true);
      isEmailTransportConfiguredMock.mockReturnValue(true);

      const res = await app.fetch(makeRequest("/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, string>;
      };
      expect(body.status).toBe("ok");
      expect(body.checks.email_transport).toBe("ok");
    });

    it("returns 503 with email_transport:'fail' when deployed and SMTP is missing", async () => {
      isEmailVerificationRequiredMock.mockReturnValue(true);
      isEmailTransportConfiguredMock.mockReturnValue(false);

      const res = await app.fetch(makeRequest("/health"));
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, string>;
      };
      expect(body.status).toBe("degraded");
      expect(body.checks.email_transport).toBe("fail");
    });

    it("does NOT gate on SMTP when running locally even if SMTP is missing", async () => {
      // Local dev intentionally has no real SMTP transport — sendEmail is a
      // no-op locally. The gate must only fire on deployed envs.
      isEmailVerificationRequiredMock.mockReturnValue(false);
      isEmailTransportConfiguredMock.mockReturnValue(false);

      const res = await app.fetch(makeRequest("/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, string>;
      };
      expect(body.status).toBe("ok");
      // No email_transport check is reported locally — the gate doesn't apply.
      expect(body.checks.email_transport).toBeUndefined();
    });
  });
});
