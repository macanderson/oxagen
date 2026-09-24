// A new workspace's slug, made from its name. The design's Create a workspace
// form (`newws`) has no slug field, and `create_workspace` requires one, so
// `createWorkspace` (actions.ts) makes it here. It lives outside the
// "use server" module because every export of one is a server action
// (INV-19), and this is a pure function.

/** The longest slug `create_workspace` takes (packages/oxagen/src/workspace-slug.ts). */
const SLUG_MAX = 40;

/**
 * A workspace slug made from its name, in the one spelling the contract takes:
 * lowercase letters and digits in groups joined by single hyphens, at most 40
 * characters. Anything else in the name becomes a hyphen between groups. A
 * name that yields a reserved or too-short slug is refused by the contract,
 * and the refusal is named on the Name field.
 */
export function slugFromName(name: string): string {
  return (
    name
      .normalize("NFKD")
      // The accents NFKD split off: "é" keeps its letter and drops its mark.
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX)
      .replace(/-+$/, "")
  );
}
