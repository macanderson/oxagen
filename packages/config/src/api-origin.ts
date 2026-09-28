const DEFAULT_API_ORIGIN = "https://api.oxagen.sh";

const SOURCES = ["NEXT_PUBLIC_API_URL", "OXAGEN_API_URL"] as const;

/**
 * The public origin of the Oxagen API, for a URL that someone outside Oxagen
 * calls back, such as a provider webhook.
 *
 * `NEXT_PUBLIC_API_URL` comes first because the env registry sets it on every
 * service, including isolated environments (`api.<domain>`). `OXAGEN_API_URL`
 * is the CLI's variable and no service sets it, so it is only the fallback for
 * a local run. A value that does not parse as a URL is skipped. The answer is
 * the origin alone, so a path or a trailing slash on the variable drops out.
 */
export function apiPublicOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  for (const name of SOURCES) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      return new URL(raw).origin;
    } catch {
      // Not a URL. Try the next source.
    }
  }
  return DEFAULT_API_ORIGIN;
}
