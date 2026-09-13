// Better Auth reports failures as `{ code, status, message }` (client) or throws
// an APIError whose body carries `code` (server `auth.api.*`). The app never
// shows Better Auth's English message: it maps the code to a catalog key under
// `auth.outcomes.*`, and anything unrecognised to `unknown`.

export type AuthOutcomeKey =
  | "wrongCredentials"
  | "emailNotVerified"
  | "suspended"
  | "rateLimited"
  | "alreadyRegistered"
  | "codeWrong"
  | "linkExpired"
  | "unavailable"
  | "unknown";

export type AuthErrorLike = {
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
];

function readError(err: unknown): AuthErrorLike | null {
  if (err === null || typeof err !== "object") return null;
  return err as AuthErrorLike;
}

/** The catalog key for a Better Auth failure. */
export function authOutcomeKey(err: unknown): AuthOutcomeKey {
  const e = readError(err);
  if (!e) return "unknown";
  if (e.status === 429) return "rateLimited";
  const code = (e.code ?? e.body?.code ?? "").toUpperCase();
  const haystack =
    code ||
    (e.message ?? e.body?.message ?? "").toUpperCase().replace(/[\s-]+/g, "_");
  for (const [pattern, key] of BY_CODE) if (pattern.test(haystack)) return key;
  if (typeof e.status === "number" && e.status >= 500) return "unavailable";
  return "unknown";
}
