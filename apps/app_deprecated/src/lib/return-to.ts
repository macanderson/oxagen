/**
 * `returnTo`: where the sign-in, second-factor, sign-up and new-organization
 * pages send the user once they are done. `/cli/authorize` sets it so the
 * CLI and the desktop app's browser login come back to the consent page
 * with their PKCE parameters intact; without it a user who was not already
 * signed in landed on `/` and the CLI waited for a callback that never came.
 *
 * Only a same-origin absolute path is honoured (`/x`, never `//evil`,
 * `https://…`, or a bare word), so the parameter cannot become an open
 * redirect.
 */
export function safeReturnTo(
  value: string | string[] | undefined | null,
): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096)
    return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\"))
    return null;
  if (/[\r\n]/.test(raw)) return null;
  return raw;
}

/** Append `returnTo` to a same-origin path, when there is one. */
export function withReturnTo(path: string, returnTo: string | null): string {
  if (returnTo === null) return path;
  const joiner = path.includes("?") ? "&" : "?";
  return `${path}${joiner}returnTo=${encodeURIComponent(returnTo)}`;
}
