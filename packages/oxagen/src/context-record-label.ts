/** A display label derived from a record slug; identity remains unchanged. */
export function contextRecordLabel(slug: string): string {
  const words = slug
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
