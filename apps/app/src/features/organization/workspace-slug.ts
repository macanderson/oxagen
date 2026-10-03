// A new workspace's slug. The Create a workspace form calls it the Name: it
// fills in from the Label as the person types (`slugFromName`), and the person
// can type their own (`slugDraft`). `create_workspace` requires one, so
// `createWorkspace` (actions.ts) makes it from the name when the form sends
// none. It lives outside the "use server" module because every export of one
// is a server action (INV-19), and these are pure functions.
import {
  RESERVED_WORKSPACE_SLUGS,
  slugFromName as deriveSlug,
  WORKSPACE_SLUG_MAX,
  WORKSPACE_SLUG_MIN,
  WORKSPACE_SLUG_PATTERN,
} from "@oxagen/oxagen/contracts/org.create";

/**
 * A workspace slug made from its name by the one rule every name-made slug
 * follows (ADR-198): lowercase letters and digits in groups joined by single
 * hyphens, at most 40 characters. A space becomes a hyphen and every other
 * special character, apostrophes included, is dropped. A name that yields a
 * reserved or too-short slug is refused by the contract, and the refusal is
 * named on the Name field.
 */
export function slugFromName(name: string): string {
  return deriveSlug(name);
}

/**
 * What the Name field keeps of what the person types: lowercase letters,
 * digits and hyphens, a space turned into a hyphen, and every other character
 * dropped. Unlike `slugFromName` it keeps a hyphen at either end, so the
 * person can type the hyphen before the next word. `slugProblem` names a slug
 * that still ends in one.
 */
export function slugDraft(typed: string): string {
  return typed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, WORKSPACE_SLUG_MAX);
}

/** Why `create_workspace` would refuse a slug, or null when it would take it. */
export type SlugProblem = "short" | "shape" | "reserved";

export function slugProblem(slug: string): SlugProblem | null {
  if (slug.length < WORKSPACE_SLUG_MIN) return "short";
  if (!WORKSPACE_SLUG_PATTERN.test(slug)) return "shape";
  if (RESERVED_WORKSPACE_SLUGS.has(slug)) return "reserved";
  return null;
}
