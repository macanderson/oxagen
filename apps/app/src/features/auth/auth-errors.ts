// Better Auth reports failures as `{ code, status, message }` (client) or throws
// an APIError whose body carries `code` (server `auth.api.*`). The app never
// shows Better Auth's English message: it maps the code to a catalog key under
// `auth.outcomes.*`, and anything unrecognised to `unknown`.
//
// Social sign-in failures also arrive as `?error=<code>` on /login (Better Auth
// OAuth errorCallbackURL, or the proxy lift from `/?error=`). Those codes are
// lowercase snake_case from the provider / Better Auth, not the client shape.

export type AuthOutcomeKey =
  | "wrongCredentials"
  | "emailNotVerified"
  | "suspended"
  | "rateLimited"
  | "alreadyRegistered"
  | "codeWrong"
  | "linkExpired"
  | "oauthCancelled"
  | "oauthFailed"
  | "unavailable"
  | "unknown";

type AuthErrorLike = {
  code?: string | undefined;
  status?: number | undefined;
  message?: string | undefined;
  body?:
    | { code?: string | undefined; message?: string | undefined }
    | undefined;
};

const BY_CODE: ReadonlyArray<readonly [RegExp, AuthOutcomeKey]> = [
  [
    /INVALID_EMAIL_OR_PASSWORD|INVALID_PASSWORD|USER_NOT_FOUND|CREDENTIAL_ACCOUNT_NOT_FOUND/,
    "wrongCredentials",
  ],
  [/EMAIL_NOT_VERIFIED/, "emailNotVerified"],
  [/BANNED|SUSPENDED/, "suspended"],
  [/USER_ALREADY_EXISTS/, "alreadyRegistered"],
  [
    /INVALID_(TWO_FACTOR_)?CODE|INVALID_BACKUP_CODE|INVALID_TOTP|OTP/,
    "codeWrong",
  ],
  [/INVALID_TOKEN|TOKEN_EXPIRED|EXPIRED_TOKEN|TOKEN_NOT_FOUND/, "linkExpired"],
  [/TOO_MANY/, "rateLimited"],
  [/ACCESS_DENIED|USER_CANCELLED|OAUTH.*CANCEL/, "oauthCancelled"],
  [
    /PLEASE_RESTART|STATE_MISMATCH|OAUTH|ACCOUNT_NOT_LINKED|UNABLE_TO_GET_USER|FAILED_TO_GET_USER|PROVIDER_NOT_FOUND|SOCIAL_ACCOUNT/,
    "oauthFailed",
  ],
];

function readError(err: unknown): AuthErrorLike | null {
  if (err === null || typeof err !== "object") return null;
  return err;
}

function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "_");
}

/** The catalog key for a Better Auth failure. */
export function authOutcomeKey(err: unknown): AuthOutcomeKey {
  const e = readError(err);
  if (!e) return "unknown";
  if (e.status === 429) return "rateLimited";
  const code = normalizeCode(e.code ?? e.body?.code ?? "");
  const haystack = code || normalizeCode(e.message ?? e.body?.message ?? "");
  for (const [pattern, key] of BY_CODE) if (pattern.test(haystack)) return key;
  if (typeof e.status === "number" && e.status >= 500) return "unavailable";
  return "unknown";
}

/**
 * The catalog key for a Better Auth / provider `?error=` query value on /login.
 * Returns null when the param is absent or empty so the form stays quiet.
 */
export function oauthQueryOutcome(
  raw: string | null | undefined,
): AuthOutcomeKey | null {
  if (raw === null || raw === undefined) return null;
  const code = normalizeCode(raw.trim());
  if (code.length === 0) return null;
  return authOutcomeKey({ code });
}
