/**
 * slug.ts — the single source of truth for turning human text into a URL slug.
 *
 * Used by every form that derives a slug from a name (org create, org settings,
 * workspace settings). Keep the rules here so the client preview, the form
 * inputs, and the server-side validation all agree on one format.
 *
 * Rules: lowercase, drop anything that isn't a URL-safe char, collapse runs of
 * whitespace to single hyphens, collapse repeated hyphens, trim leading/trailing
 * hyphens. The server actions validate the result against
 * `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
 */

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // drop anything that isn't url-safe
    .replace(/\s+/g, "-") // whitespace runs → single hyphen
    .replace(/-+/g, "-") // collapse repeated hyphens
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}
