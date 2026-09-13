/**
 * security-types.ts
 *
 * Types shared between the profile page (server component), connected-accounts
 * client component, and set-password form. Per the standard-extract-shared-types
 * policy: any type used in ≥2 files lives here.
 */

/** A single account row returned by auth.api.listUserAccounts. */
export interface LinkedAccount {
  id: string;
  providerId: string;
  accountId: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
  scopes: string[];
}

/**
 * Derived security state passed from the server component to client components.
 * Computed once server-side so the initial render is correct with no flash.
 */
export interface ConnectedAccountsState {
  /** All accounts linked to this user (from auth.api.listUserAccounts). */
  accounts: LinkedAccount[];
  /** True if the user has a credential account (providerId === 'credential') with a non-null password. */
  hasPassword: boolean;
  /**
   * Count of distinct sign-in methods:
   *   - Each social provider (google, github) counts as 1 when linked.
   *   - The credential account counts as 1 only when hasPassword === true.
   *
   * When signInMethodCount === 1, the user's only remaining sign-in method
   * must not be removed.
   */
  signInMethodCount: number;
}

/** Return type for the setPasswordAction server action. */
export type SetPasswordActionResult =
  | { ok: true }
  | { ok: false; error: string };

/** Return type for the unlinkAccountAction server action. */
export type UnlinkAccountActionResult =
  | { ok: true }
  | { ok: false; error: string };
