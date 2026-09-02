/**
 * reset-password/actions.test.ts — unit tests for resetPasswordAction.
 *
 * Covers:
 *   (a) Happy path — ok:true on valid token + matching passwords.
 *   (b) Zod validation — password too short, too long, missing token.
 *   (c) Password mismatch — caught before the API call.
 *   (d) Invalid/expired token — mapped to friendly message.
 *   (e) Generic API error — mapped to generic message.
 *
 * Mock seam: @oxagen/auth (auth.api.resetPassword).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vi.mock is hoisted).
// ---------------------------------------------------------------------------

const { mockResetPassword } = vi.hoisted(() => ({
  mockResetPassword: vi.fn(),
}));

vi.mock("@oxagen/auth", () => ({
  auth: {
    api: {
      resetPassword: mockResetPassword,
    },
  },
}));

import { resetPasswordAction } from "./actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = "abc123-valid-token";
const VALID_PASSWORD = "securepass1";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resetPasswordAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("(a) happy path", () => {
    it("returns ok:true when the API accepts the token and new password", async () => {
      mockResetPassword.mockResolvedValue({ status: true });

      const result = await resetPasswordAction({
        token: VALID_TOKEN,
        newPassword: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      });

      expect(result.ok).toBe(true);
      expect(mockResetPassword).toHaveBeenCalledOnce();
      expect(mockResetPassword).toHaveBeenCalledWith(
        expect.objectContaining({
          body: { token: VALID_TOKEN, newPassword: VALID_PASSWORD },
        }),
      );
    });
  });

  describe("(b) Zod validation", () => {
    it("returns ok:false when token is empty string", async () => {
      const result = await resetPasswordAction({
        token: "",
        newPassword: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /token is missing/i,
      );
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it("returns ok:false when password is too short (< 8 chars)", async () => {
      const result = await resetPasswordAction({
        token: VALID_TOKEN,
        newPassword: "short",
        confirmPassword: "short",
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /at least 8/i,
      );
      expect(mockResetPassword).not.toHaveBeenCalled();
    });

    it("returns ok:false when password exceeds 128 chars", async () => {
      const tooLong = "a".repeat(129);
      const result = await resetPasswordAction({
        token: VALID_TOKEN,
        newPassword: tooLong,
        confirmPassword: tooLong,
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /at most 128/i,
      );
      expect(mockResetPassword).not.toHaveBeenCalled();
    });
  });

  describe("(c) password mismatch", () => {
    it("returns ok:false when passwords do not match", async () => {
      const result = await resetPasswordAction({
        token: VALID_TOKEN,
        newPassword: "securepass1",
        confirmPassword: "different!!",
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toBe(
        "Passwords do not match",
      );
      expect(mockResetPassword).not.toHaveBeenCalled();
    });
  });

  describe("(d) invalid or expired token", () => {
    it("returns ok:false with friendly message when API throws INVALID_TOKEN", async () => {
      mockResetPassword.mockRejectedValue(new Error("INVALID_TOKEN"));

      const result = await resetPasswordAction({
        token: "bad-token",
        newPassword: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /invalid or has expired/i,
      );
    });

    it("returns ok:false with friendly message when API says Token not found", async () => {
      mockResetPassword.mockRejectedValue(new Error("Token not found"));

      const result = await resetPasswordAction({
        token: "expired-token",
        newPassword: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /invalid or has expired/i,
      );
    });
  });

  describe("(e) generic API error", () => {
    it("returns ok:false with generic message on unexpected error", async () => {
      mockResetPassword.mockRejectedValue(new Error("Internal server error"));

      const result = await resetPasswordAction({
        token: VALID_TOKEN,
        newPassword: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
      });

      expect(result.ok).toBe(false);
      expect((result as { ok: false; error: string }).error).toMatch(
        /failed to reset password/i,
      );
    });
  });
});
