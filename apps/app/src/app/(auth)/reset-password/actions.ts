"use server";
/**
 * reset-password/actions.ts — server action for applying a password reset.
 *
 * Takes the one-time token (from URL query ?token=) and the new password.
 * Calls auth.api.resetPassword which verifies the token, updates the
 * credential, and deletes the token (single-use).
 *
 * Because revokeSessionsOnPasswordReset is true in auth.ts, all active
 * sessions are invalidated on success.
 *
 * Pattern mirrors security-action.ts:
 *   - zod validation → typed result { ok: true } | { ok: false, error: string }
 *   - never throw past the action boundary
 *   - never log the password value
 */

import { z } from "zod";
import { auth } from "@oxagen/auth";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type ResetPasswordResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ResetPasswordSchema = z.object({
  token: z.string().min(1, "Reset token is missing"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
  confirmPassword: z.string(),
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Apply a password reset using the one-time token from the email link.
 *
 * Returns ok:false with a user-friendly message on:
 *   - validation failure (short/long/mismatch)
 *   - invalid or expired token
 *   - any unexpected error
 */
export async function resetPasswordAction(
  input: z.infer<typeof ResetPasswordSchema>,
): Promise<ResetPasswordResult> {
  const parsed = ResetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const { token, newPassword, confirmPassword } = parsed.data;

  if (newPassword !== confirmPassword) {
    return { ok: false, error: "Passwords do not match" };
  }

  try {
    await auth.api.resetPassword({
      body: { token, newPassword },
    });

    return { ok: true };
  } catch (err: unknown) {
    // Never log the password. Capture the error message only.
    const message = err instanceof Error ? err.message : "";

    if (
      message.includes("INVALID_TOKEN") ||
      message.includes("invalid token") ||
      message.includes("Token not found") ||
      message.includes("token") // catch-all for token-related errors
    ) {
      return {
        ok: false,
        error:
          "This reset link is invalid or has expired. Please request a new one.",
      };
    }

    if (message.includes("PASSWORD_TOO_SHORT") || message.includes("too short")) {
      return { ok: false, error: "Password is too short (minimum 8 characters)" };
    }

    if (message.includes("PASSWORD_TOO_LONG") || message.includes("too long")) {
      return { ok: false, error: "Password is too long (maximum 128 characters)" };
    }

    return {
      ok: false,
      error: "Failed to reset password. Please request a new link.",
    };
  }
}
