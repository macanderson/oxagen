// The Repositories page's tabs (mockup route `repositories[/<tab>]`): the
// first is the bare path and the rest are one path segment each, so a tab
// survives a reload and a shared link.

const REPOSITORY_TABS = [
  "repositories",
  "working-copies",
  "changes",
  "configuration",
] as const;
export type RepositoryTab = (typeof REPOSITORY_TABS)[number];

/**
 * The tab a route's optional catch-all names: none is the first tab, one
 * known segment is that tab, and anything else is null, which the route
 * answers with a 404 rather than a page that guesses.
 */
export function parseRepositoryTab(
  segments: readonly string[] | undefined,
): RepositoryTab | null {
  if (segments === undefined || segments.length === 0) return "repositories";
  if (segments.length !== 1) return null;
  const [segment] = segments;
  if (segment === "repositories") return null;
  return REPOSITORY_TABS.find((tab) => tab === segment) ?? null;
}
