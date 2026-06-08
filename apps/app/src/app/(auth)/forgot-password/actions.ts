"use server";
/**
 * forgot-password/actions.ts — server action for requesting a password reset.
 *
 * Security contract (anti-enumeration):
 *   Always returns { ok: true } regardless of whether an account exists for
 *   the submitted email. The UI shows a neutral "if an account exists, we
 *   sent a link" message — never confirming or denying account existence.
 *
 * Pattern mirrors security-action.ts:
 *   - zod validation → typed result { ok: true } | { ok: false, error: string }
 *   - never throw past the action boundary
 */

import { z } from "zod";
import { auth } from "@oxagen/auth";
import { loadEnv } from "@oxagen/config/env";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type RequestResetResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const RequestResetSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

/**
 * Trigger a password-reset email for the given email address.
 *
 * Always succeeds from the caller's perspective (anti-enumeration). The email
 * is sent (or silently skipped for unknown addresses) by Better Auth + the
 * sendResetPassword callback in packages/auth/src/auth.ts.
 *
 * The redirectTo URL points to the app's /reset-password page so Better Auth
 * generates a link the user can open in the browser. Better Auth appends the
 * token as a query parameter: /reset-password?token=<TOKEN>.
 */
export async function requestResetAction(
  input: z.infer<typeof RequestResetSchema>,
): Promise<RequestResetResult> {
  const parsed = RequestResetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Enter a valid email address",
    };
  }

  try {
    const appBaseUrl = loadEnv().BETTER_AUTH_URL;

    await auth.api.requestPasswordReset({
      body: {
        email: parsed.data.email,
        redirectTo: `${appBaseUrl}/reset-password`,
      },
    });
  } catch {
    // Swallow all errors — we must never reveal whether an account exists.
    // The email is only dispatched if Better Auth finds a matching account.
  }

  // Always return ok:true (neutral response — anti-enumeration).
  return { ok: true };
}
