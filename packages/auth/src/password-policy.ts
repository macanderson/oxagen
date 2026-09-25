/**
 * The password policy for a new password: at least 12 characters, at most 128,
 * one symbol, and one digit.
 *
 * This module is the one source of the rule. The app's sign-up and reset
 * screens list and tick it (apps/app/src/features/auth/schemas.ts), and the
 * server refuses a password that misses it (./password-policy-plugin.ts), so a
 * direct call to /sign-up/email or /reset-password cannot set a password the
 * screens would refuse (#3888).
 *
 * It is pure and edge-safe: the browser bundle imports it through the
 * `@oxagen/auth/password-policy` subpath, so it must not import Better Auth,
 * the database, or anything server-only.
 */

/** The fewest characters a new password may have. */
export const PASSWORD_MIN = 12;
/** The most characters a password may have. Better Auth's own default is the same. */
export const PASSWORD_MAX = 128;
/** Any character that is not an ASCII letter or digit counts as a symbol. */
export const HAS_SYMBOL = /[^A-Za-z0-9]/;
export const HAS_DIGIT = /[0-9]/;

/** The error code the server returns when a new password misses the policy. */
export const PASSWORD_TOO_WEAK_CODE = "PASSWORD_TOO_WEAK";

/** The three requirements in the order the screens list them, each true once the value meets it. */
export function passwordRequirements(value: string): {
  length: boolean;
  symbol: boolean;
  digit: boolean;
} {
  return {
    length: value.length >= PASSWORD_MIN,
    symbol: HAS_SYMBOL.test(value),
    digit: HAS_DIGIT.test(value),
  };
}

/**
 * The sentence naming the first rule a new password misses, or null when it
 * meets them all. The rules are checked in the order the screens list them,
 * with the upper length bound last.
 */
export function passwordPolicyViolation(value: string): string | null {
  const met = passwordRequirements(value);
  if (!met.length) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (!met.symbol) return "Password must contain at least one symbol.";
  if (!met.digit) return "Password must contain at least one digit.";
  if (value.length > PASSWORD_MAX) {
    return `Password must be at most ${PASSWORD_MAX} characters.`;
  }
  return null;
}
