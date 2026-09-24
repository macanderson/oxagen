/** A lineage id: lowercase letters, digits, dots and hyphens, starting and ending on a letter or digit. */
export const CONTEXT_RECORD_LINEAGE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/**
 * A display label derived from a record slug; identity remains unchanged.
 * The `ctx.<set>.` namespace every minted lineage carries is dropped, so
 * `ctx.core.do-not-re-read` reads "Do Not Re Read".
 */
export function contextRecordLabel(slug: string): string {
  const words = slug
    .replace(/^ctx\.[^.]+\./i, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return (
    words
      .toLowerCase()
      .replace(
        /(^|\s)(\p{L})/gu,
        (_, gap: string, letter: string) => gap + letter.toUpperCase(),
      )
      .slice(0, 200) || "Context Record"
  );
}

/** A file-safe lineage from an editable name or slug. */
export function contextRecordSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 200)
    .replace(/[.-]+$/g, "");
}
