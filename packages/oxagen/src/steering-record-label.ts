/** A lineage id: lowercase letters, digits, dots and hyphens, starting and ending on a letter or digit. */
export const STEERING_RECORD_LINEAGE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/**
 * The longest label a steering record carries (ADR-178). A label is the
 * record's name on every surface, so it has to fit a heading, a list row and a
 * breadcrumb. The statement is where the sentence goes.
 */
export const STEERING_RECORD_LABEL_MAX = 36;

/**
 * A label as a person typed it, fitted to STEERING_RECORD_LABEL_MAX: trimmed,
 * runs of whitespace collapsed, and cut at the last word boundary that fits.
 * A single word longer than the cap is cut mid-word, since that is the only
 * way to fit it.
 */
export function fitSteeringRecordLabel(value: string): string {
  const tidy = value.trim().replace(/\s+/g, " ");
  if (tidy.length <= STEERING_RECORD_LABEL_MAX) return tidy;
  const cut = tidy.slice(0, STEERING_RECORD_LABEL_MAX + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, -1)).trimEnd();
}

/**
 * A display label derived from a record slug; identity remains unchanged.
 * The `ctx.<set>.` namespace every minted lineage carries is dropped, so
 * `ctx.core.do-not-re-read` reads "Do Not Re Read".
 */
export function steeringRecordLabel(slug: string): string {
  const words = slug
    .replace(/^ctx\.[^.]+\./i, "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return (
    fitSteeringRecordLabel(
      words
        .toLowerCase()
        .replace(
          /(^|\s)(\p{L})/gu,
          (_, gap: string, letter: string) => gap + letter.toUpperCase(),
        ),
    ) || "Steering Record"
  );
}

/** A file-safe lineage from an editable name or slug. */
export function steeringRecordSlug(value: string): string {
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
