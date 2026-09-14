/**
 * slug.ts — the single source of truth for turning human text into a URL slug.
 *
 * Used by every form that derives a slug from a name (org create, org settings,
 * workspace settings, agent/skill/sandbox-template builders). Keep the rules
 * here so the client preview, the form inputs, and the server-side validation
 * all agree on one format.
 *
 * Rules: lowercase, collapse any run of non-alphanumeric characters (spaces,
 * punctuation, existing hyphens) into a single hyphen, trim leading/trailing
 * hyphens. The server actions validate the result against
 * `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
 *
 * An optional `maxLen` truncates the result (used by builders that cap slug
 * length, e.g. agent/skill names).
 */

export function slugify(input: string, maxLen?: number): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics → single hyphen
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
  if (typeof maxLen !== "number") return slug;
  // Re-trim after truncating: a cut that lands on a hyphen ("my-agent" → "my-")
  // would otherwise emit a slug the server's SLUG_PATTERN rejects, so the
  // builder would show a valid-looking value that fails on save.
  return slug.slice(0, maxLen).replace(/-+$/, "");
}

/**
 * The canonical slug format the server actions validate against — lowercase
 * kebab-case, no leading/trailing/double hyphens, no dots or other punctuation.
 * This is the SAME pattern the org/workspace create + settings actions enforce;
 * exported here so slug consumers (routing, resolvers) share one definition
 * instead of re-inlining the regex.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * True when `value` is a well-formed slug. Cheap, allocation-free guard used to
 * reject strings that could never be a real org/workspace slug BEFORE spending
 * a DB round-trip on them — e.g. static/metadata paths that fall through to the
 * `[orgSlug]` route (`favicon.ico`, `robots.txt`, `sitemap.xml`,
 * `apple-touch-icon.png`), all of which contain a `.` and so fail this test.
 */
export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}
