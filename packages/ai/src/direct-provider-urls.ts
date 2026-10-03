/**
 * The OpenAI-compatible endpoint of each direct vendor whose URL Oxagen spells
 * (ADR-053 §2). The provider client (`models.ts`) sends a direct credential's
 * completions here, and the credential probe (`credential-probe.ts`) sends its
 * tool-calling question to the same place, so the probe asks the endpoint the
 * turn will use (#3314). `openai_compatible` is absent: its URL is the
 * customer's.
 *
 * A module of its own so the probe does not import `models.ts`, which pulls
 * in the gateway client and the environment. `splitBaseUrlQuery` lives here
 * for the same reason: both read a customer's URL the same way.
 */
export const DIRECT_PROVIDER_BASE_URL = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
} as const;

/**
 * A base URL cut at its query: what comes before the first `?` or `#`, and
 * that mark with everything after it. `query` is "" when there is none.
 *
 * A customer's endpoint can carry a query every request needs, such as Azure
 * OpenAI's `?api-version=…`. A path joined onto the whole string lands inside
 * that query, so the probe and the provider client both join the path onto
 * `base` and keep `query` after it (#3317).
 */
export function splitBaseUrlQuery(baseUrl: string): {
  base: string;
  query: string;
} {
  const cut = baseUrl.search(/[?#]/);
  return cut === -1
    ? { base: baseUrl, query: "" }
    : { base: baseUrl.slice(0, cut), query: baseUrl.slice(cut) };
}
