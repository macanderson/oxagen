// A new workspace's slug, made from its name. The design's Create a workspace
// form (`newws`) has no slug field, and `create_workspace` requires one, so
// `createWorkspace` (actions.ts) makes it here. It lives outside the
// "use server" module because every export of one is a server action
// (INV-19), and this is a pure function.
import { slugFromName as deriveSlug } from "@oxagen/oxagen/contracts/org.create";

/**
 * A workspace slug made from its name by the one rule every name-made slug
 * follows (ADR-192): lowercase letters and digits in groups joined by single
 * hyphens, at most 40 characters. A space becomes a hyphen and every other
 * special character, apostrophes included, is dropped. A name that yields a
 * reserved or too-short slug is refused by the contract, and the refusal is
 * named on the Name field.
 */
export function slugFromName(name: string): string {
  return deriveSlug(name);
}
