/** Case-insensitive match on name or slug; an empty query keeps everything. */
export function filterByName<T extends { name: string; slug: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return [...items];
  return items.filter(
    (item) =>
      item.name.toLocaleLowerCase().includes(q) ||
      item.slug.toLocaleLowerCase().includes(q),
  );
}
