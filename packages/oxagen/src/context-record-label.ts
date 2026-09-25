/** A lineage id: lowercase letters, digits, dots and hyphens, starting and ending on a letter or digit. */
export const CONTEXT_RECORD_LINEAGE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/**
 * The longest label a context record carries (ADR-174). A label is the
 * record's name on every surface, so it has to fit a heading, a list row and a
 * breadcrumb. The statement is where the sentence goes.
 */
export const CONTEXT_RECORD_LABEL_MAX = 36;

/**
 * A label as a person typed it, fitted to CONTEXT_RECORD_LABEL_MAX: trimmed,
 * runs of whitespace collapsed, and cut at the last word boundary that fits.
 * A single word longer than the cap is cut mid-word, since that is the only
 * way to fit it.
 */
export function fitContextRecordLabel(value: string): string {
  const tidy = value.trim().replace(/\s+/g, " ");
  if (tidy.length <= CONTEXT_RECORD_LABEL_MAX) return tidy;
  const cut = tidy.slice(0, CONTEXT_RECORD_LABEL_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, -1)).trimEnd();
}

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
    fitContextRecordLabel(
      words
        .toLowerCase()
        .replace(
          /(^|\s)(\p{L})/gu,
          (_, gap: string, letter: string) => gap + letter.toUpperCase(),
        ),
    ) || "Context Record"
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
