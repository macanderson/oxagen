// run-pr-link-repository.ts — the repository of a recorded pull request link
// when the workspace does not link that repository (#5296).
//
// A run's record can name a pull request in a repository another workspace
// links, when an agent of this workspace worked there. The link is still
// certain, so the pull request is read through the workspace's own GitHub
// connection for its owner. The ADR-192 backfill reads the same pull
// request's state through that connection. `get_run_work` reads the pull
// request itself, and `get_run_issues` reads what it closes.
import type { RunScope } from "../run.list";
import { logger } from "../logger";
import type { ConnectedRunRepository } from "./run-work";

/**
 * The id of the workspace's GitHub connection that reads an owner's
 * repositories, or null when none does (`githubConnectionFor`).
 */
export type GithubConnectionLookup = (
  scope: RunScope,
  owner: string,
) => Promise<string | null>;

/**
 * What a link in an unlinked repository resolves to: the repository to read,
 * with the owner's connection and `connected: false`. `not_connected` means
 * no connection reaches the owner, or the link is not on github.com.
 * `lookup_failed` means the connection read itself failed.
 */
export type UnlinkedLinkRepository =
  | ConnectedRunRepository
  | "not_connected"
  | "lookup_failed";

/** A recorded link's owner, name and URL, as `prLinkOf` reads them. */
export type RecordedLink = { owner: string; name: string; url: string };

/** Resolves one recorded link in a repository the workspace does not link. */
export type UnlinkedRepositoryResolver = (
  link: RecordedLink,
) => Promise<UnlinkedLinkRepository>;

/**
 * A resolver for one read. It looks up each owner once and builds each
 * repository once, so links that repeat a repository, in any letter case,
 * share one repository and its reads.
 *
 * Only a github.com link goes to a GitHub connection. A GitLab owner can
 * share a GitHub owner's name. `caller` names the capability in the log line
 * a failed lookup writes.
 */
export function unlinkedRepositoryResolver(
  scope: RunScope,
  lookup: GithubConnectionLookup,
  caller: string,
): UnlinkedRepositoryResolver {
  const owners = new Map<string, Promise<string | null | undefined>>();
  const built = new Map<string, ConnectedRunRepository>();
  return async (link) => {
    if (new URL(link.url).hostname !== "github.com") return "not_connected";
    const owner = link.owner.toLowerCase();
    let found = owners.get(owner);
    if (found === undefined) {
      // Undefined means the lookup failed, which is a failed read and not
      // an owner no connection reaches.
      found = lookup(scope, owner).catch((err: unknown) => {
        logger.warn(
          { err, orgId: scope.orgId, workspaceId: scope.workspaceId },
          `${caller}: the GitHub connection for a recorded pull request could not be read`,
        );
        return undefined;
      });
      owners.set(owner, found);
    }
    const connectionId = await found;
    if (connectionId === undefined) return "lookup_failed";
    if (connectionId === null) return "not_connected";
    const key = `${link.owner}/${link.name}`.toLowerCase();
    let repository = built.get(key);
    if (repository === undefined) {
      repository = {
        connectionId,
        host: "github.com",
        owner: link.owner,
        name: link.name,
        url: `https://github.com/${link.owner}/${link.name}`,
        connected: false,
      };
      built.set(key, repository);
    }
    return repository;
  };
}
