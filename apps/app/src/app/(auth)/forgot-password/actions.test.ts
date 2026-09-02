/**
 * forgot-password/actions.test.ts — unit tests for requestResetAction.
 *
 * Covers:
 *   (a) Happy path — always returns ok:true regardless of account existence
 *       (anti-enumeration: the server action cannot reveal account status).
 *   (b) Zod validation — invalid email returns ok:false with user-friendly msg.
 *   (c) API error — swallowed; still returns ok:true (anti-enumeration).
 *
 * Mock seam: @oxagen/auth (auth.api.requestPasswordReset), process.env.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vi.mock is hoisted).
// ---------------------------------------------------------------------------

const { mockRequestPasswordReset } = vi.hoisted(() => ({
  mockRequestPasswordReset: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  auth: {
    api: {
      requestPasswordReset: mockRequestPasswordReset,
    },
  },
}));

const { mockLoadEnv } = vi.hoisted(() => ({
  mockLoadEnv: vi.fn(() => ({ BETTER_AUTH_URL: "http://localhost:3000" })),
}));

// Hermetic env: without this mock the action's loadEnv() reads ambient
// process.env, so the suite's outcome depended on the developer's shell
// exports (it failed under a stale terminal env and passed in CI by luck).
vi.mock("@oxagen/config/env", () => ({
  loadEnv: mockLoadEnv,
}));

// The action reports both failure paths through the structured logger (never
// console), so the (d) case asserts against this mock rather than a
// console.error spy — a bare console.error never reaches the log sink.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@oxagen/handlers/logger", () => ({ logger: mockLogger }));

// next/headers and next/cache are not needed here (no session or revalidatePath)
// but must be mocked if transitively imported.

import { requestResetAction } from "./actions";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requestResetAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("(a) happy path — always returns ok:true", () => {
    it("returns ok:true when the API succeeds", async () => {
      mockRequestPasswordReset.mockResolvedValue({ status: true });

      const result = await requestResetAction({ email: "user@example.com" });

      expect(result.ok).toBe(true);
    });

    it("calls auth.api.requestPasswordReset with the email and a redirectTo URL", async () => {
      mockRequestPasswordReset.mockResolvedValue({ status: true });

      await requestResetAction({ email: "someone@example.com" });

      expect(mockRequestPasswordReset).toHaveBeenCalledOnce();
      expect(mockRequestPasswordReset).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            email: "someone@example.com",
            redirectTo: "http://localhost:3000/reset-password",
          }),
        }),
      );
    });
  });

  describe("(b) Zod validation — invalid email", () => {
    it("returns ok:false when email is empty string", async () => {
      const result = await requestResetAction({ email: "" });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /valid email/i,
      );
      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    });

    it("returns ok:false when email is malformed", async () => {
      const result = await requestResetAction({ email: "not-an-email" });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /valid email/i,
      );
      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe("(c) API error — swallowed for anti-enumeration", () => {
    it("returns ok:true even when the API throws (account not found scenario)", async () => {
      mockRequestPasswordReset.mockRejectedValue(new Error("User not found"));

      const result = await requestResetAction({
        email: "noaccount@example.com",
      });

      // Anti-enumeration: must always succeed to the caller.
      expect(result.ok).toBe(true);
    });

    it("returns ok:true even when the API throws a network error", async () => {
      mockRequestPasswordReset.mockRejectedValue(new Error("Network timeout"));

      const result = await requestResetAction({ email: "user@example.com" });

      expect(result.ok).toBe(true);
    });
  });

  describe("(d) config error — surfaced, not swallowed", () => {
    it("returns ok:false and never calls the API when loadEnv throws", async () => {
      mockLoadEnv.mockImplementationOnce(() => {
        throw new Error("Invalid environment");
      });
      const result = await requestResetAction({ email: "user@example.com" });

      // A misconfigured server is the same failure for every email — no
      // enumeration risk — and must NOT report ok while no email was sent.
      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /unavailable/i,
      );
      expect(mockRequestPasswordReset).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
