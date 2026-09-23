// The Repositories page's tabs (mockup route `repositories[/<tab>]`): the
// first is the bare path and the rest are one path segment each, so a tab
// survives a reload and a shared link.
import type {
  InstallationRepositories,
  RepositoryTree,
  WorkspaceRepositories,
} from "@/data/contracts/repository";
import type { Load } from "./parts";

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

type Bound = WorkspaceRepositories["repositories"][number];
type Reachable = InstallationRepositories["repositories"][number];

/** A repository's role in this workspace: the workspace's word, not GitHub's. */
export type RepositoryRole = "main" | "linked" | "available";

/** What the `.oxagen/` cell says, read from the production branch. */
export type TreeState =
  | "governed"
  | "absent"
  | "reading"
  | "unread"
  | "branchMissing"
  | "unknown";

/**
 * One row of the Repositories table: a repository this workspace binds (main
 * or linked), or one the installation reaches that it does not (not linked).
 */
export type RepositoryRow = {
  fullName: string;
  owner: string;
  name: string;
  role: RepositoryRole;
  /** What `unlink_repository` and `get_repository_tree` take; null when not linked. */
  bindingId: string | null;
  /** The binding's production branch, or GitHub's default for a repository not linked. */
  productionBranch: string;
  visibility: "private" | "public" | null;
  htmlUrl: string;
  /** The App's delivery state for a bound repository; null when not linked. */
  events: Bound["events"] | null;
  connectionLive: boolean;
  tree: Load<RepositoryTree> | null;
};

/** The `.oxagen/` state a row's tree read answers, or unknown for a repository nothing read. */
export function treeState(tree: Load<RepositoryTree> | null): TreeState {
  if (tree === null) return "unknown";
  if (tree.kind === "loading") return "reading";
  if (tree.kind === "failed") return "unread";
  if (tree.value.head === null) return "branchMissing";
  return tree.value.oxagen.present ? "governed" : "absent";
}

/**
 * The table's rows: every bound repository, main first, then every repository
 * the installation reaches that nobody bound, as not linked. A repository is
 * matched across the two reads by its full name, without case.
 */
export function repositoryRows(
  bound: readonly Bound[],
  trees: Readonly<Record<string, Load<RepositoryTree>>>,
  reachable: readonly Reachable[],
): RepositoryRow[] {
  const byName = new Map(
    reachable.map((repository) => [
      repository.fullName.toLowerCase(),
      repository,
    ]),
  );
  const rows: RepositoryRow[] = [...bound]
    .sort((a, b) =>
      a.role === b.role ? 0 : a.role === "main" ? -1 : 1,
    )
    .map((repository) => {
      const seen = byName.get(repository.fullName.toLowerCase());
      return {
        fullName: repository.fullName,
        owner: repository.owner,
        name: repository.name,
        role: repository.role,
        bindingId: repository.bindingId,
        productionBranch: repository.defaultRef,
        visibility:
          seen === undefined ? null : seen.private ? "private" : "public",
        htmlUrl: repository.htmlUrl,
        events: repository.events,
        connectionLive: repository.connectionLive,
        tree: trees[repository.bindingId] ?? { kind: "loading" },
      };
    });
  const boundNames = new Set(
    bound.map((repository) => repository.fullName.toLowerCase()),
  );
  for (const repository of reachable) {
    if (boundNames.has(repository.fullName.toLowerCase())) continue;
    rows.push({
      fullName: repository.fullName,
      owner: repository.owner,
      name: repository.name,
      role: "available",
      bindingId: null,
      productionBranch: repository.defaultBranch,
      visibility: repository.private ? "private" : "public",
      htmlUrl: repository.htmlUrl,
      events: null,
      connectionLive: true,
      tree: null,
    });
  }
  return rows;
}
