"use server";
/**
 * security-action.ts — server actions for account security.
 *
 * setPasswordAction: sets an initial password for an OAuth-only user.
 * unlinkAccountAction: unlinks a social provider; enforces last-method guard.
 *
 * Pattern matches profile-action.ts:
 *   - zod validation → typed result { ok: true } | { ok: false, error: string }
 *   - never throw past the action boundary
 *   - never log the password value
 *   - revalidatePath on success so the server re-derives hasPassword state
 */

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@oxagen/auth";
import { getSessionOrRedirect } from "@/lib/session";
import type {
  SetPasswordActionResult,
  UnlinkAccountActionResult,
  ConnectedAccountsState,
} from "./security-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the current user's accounts and derives ConnectedAccountsState.
 * Used both in this module and exported for the page server component.
 */
export async function fetchConnectedAccountsState(
  userId: string,
  reqHeaders: Awaited<ReturnType<typeof headers>>,
): Promise<ConnectedAccountsState> {
  const accountList = await auth.api.listUserAccounts({
    headers: reqHeaders,
  });

  const accounts = (accountList ?? []) as ConnectedAccountsState["accounts"];

  // Better Auth's /list-accounts endpoint strips the password field for security,
  // so we cannot read it from the response. Instead, we detect the presence of a
  // "credential" provider account: the setPassword endpoint creates this account
  // only when no password exists yet, and throws PASSWORD_ALREADY_SET otherwise.
  // Therefore, a credential account in the list means a password has been set.
  const hasPassword = accounts.some((a) => a.providerId === "credential");

  // Count distinct sign-in methods:
  //   - credential (password) counts only when present
  //   - each social provider counts once
  const socialProviders = accounts
    .filter((a) => a.providerId !== "credential")
    .map((a) => a.providerId);
  const uniqueSocialCount = new Set(socialProviders).size;
  const signInMethodCount = uniqueSocialCount + (hasPassword ? 1 : 0);

  return { accounts, hasPassword, signInMethodCount };
}

// ---------------------------------------------------------------------------
// setPasswordAction
// ---------------------------------------------------------------------------

const SetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
  confirmPassword: z.string(),
});

export async function setPasswordAction(
  input: z.infer<typeof SetPasswordSchema>,
): Promise<SetPasswordActionResult> {
  try {
    const session = await getSessionOrRedirect();

    const parsed = SetPasswordSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const { newPassword, confirmPassword } = parsed.data;

    if (newPassword !== confirmPassword) {
      return { ok: false, error: "Passwords do not match" };
    }

    // Defensive: confirm user is authenticated before calling the API.
    if (!session.user) {
      return { ok: false, error: "Not authenticated" };
    }

    const reqHeaders = await headers();

    // auth.api.setPassword — Better Auth's built-in endpoint for setting an
    // initial password on a user who has no credential account.
    // If the user already has a password it throws PASSWORD_ALREADY_SET (400).
    await auth.api.setPassword({
      body: { newPassword },
      headers: reqHeaders,
    });

    revalidatePath("/account/profile");
    return { ok: true };
  } catch (err: unknown) {
    // Never log the password. Capture the error message only.
    const message =
      err instanceof Error ? err.message : "Failed to set password";
    // Better Auth throws a structured APIError; surface a user-friendly message.
    if (
      message.includes("PASSWORD_ALREADY_SET") ||
      message.includes("already set")
    ) {
      return { ok: false, error: "A password is already set on this account" };
    }
    if (
      message.includes("PASSWORD_TOO_SHORT") ||
      message.includes("too short")
    ) {
      return {
        ok: false,
        error: "Password is too short (minimum 8 characters)",
      };
    }
    if (message.includes("PASSWORD_TOO_LONG") || message.includes("too long")) {
      return {
        ok: false,
        error: "Password is too long (maximum 128 characters)",
      };
    }
    return { ok: false, error: "Failed to set password. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// unlinkAccountAction
// ---------------------------------------------------------------------------

const UnlinkAccountSchema = z.object({
  providerId: z.string().min(1),
  accountId: z.string().optional(),
});

export async function unlinkAccountAction(
  input: z.infer<typeof UnlinkAccountSchema>,
): Promise<UnlinkAccountActionResult> {
  try {
    await getSessionOrRedirect();

    const parsed = UnlinkAccountSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const reqHeaders = await headers();

    // Verify the last-method guard BEFORE calling the unlink API.
    // This prevents a confusing error from the server and gives us a clear,
    // user-friendly message.
    const state = await fetchConnectedAccountsState("", reqHeaders);

    if (state.signInMethodCount <= 1) {
      return {
        ok: false,
        error:
          "Set a password or connect another account before disconnecting this one.",
      };
    }

    await auth.api.unlinkAccount({
      body: {
        providerId: parsed.data.providerId,
        accountId: parsed.data.accountId,
      },
      headers: reqHeaders,
    });

    revalidatePath("/account/profile");
    return { ok: true };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to unlink account";
    if (
      message.includes("FAILED_TO_UNLINK_LAST_ACCOUNT") ||
      message.includes("last account")
    ) {
      return {
        ok: false,
        error:
          "Set a password or connect another account before disconnecting this one.",
      };
    }
    if (
      message.includes("ACCOUNT_NOT_FOUND") ||
      message.includes("not found")
    ) {
      return { ok: false, error: "Account not found" };
    }
    return {
      ok: false,
      error: "Failed to disconnect account. Please try again.",
    };
  }
}
