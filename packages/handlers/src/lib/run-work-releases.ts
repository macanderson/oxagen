// run-work-releases.ts — the releases a wrapped session created, for
// get_run_work's `releases` and the Changes panel's Release row (#3890,
// ADR-197).
//
// A release is recorded by the frame that created it: `gh release create
// <tag>` in a command frame's head, or the `release.*` attrs the recorder
// writes on a GitHub MCP release call (`releaseRefsOfFrame`). Its
// state is GitHub's, read when the page loads through the workspace's
// connection for the repository, because a draft is published later by a
// person and a stamped state would go stale. A tag GitHub has no release for
// reads `state: null` with `release_not_found`, and a read that fails reads
// `state: null` with `release_read_failed`, so neither is ever drawn as a
// guess.
import { createGitHubClient, type GitHubClient, type GitHubRelease } from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import {
  RUN_RELEASE_MAX,
  type RunCheckout,
  type RunRelease,
} from "@oxagen/oxagen/contracts/run.work.get";
import type { RunScope } from "../run.list";
import { logger } from "../logger";
import {
  chInstant,
  COMMAND_REF_FRAME_CAP,
  type CommandRefFrameRow,
  connectionOf,
  releaseRefsOfFrame,
  resolveFrameRepository,
} from "./run-command-refs";
import type { ConnectedRunRepository } from "./run-work";

/** A full page from GitHub's release list; a tag past it is not read. */
const RELEASE_PAGE = 100;

export interface WorkReleaseDeps {
  client: (
    scope: RunScope,
    repository: ConnectedRunRepository,
  ) => Promise<Pick<GitHubClient, "listReleases">>;
}

export const defaultWorkReleaseDeps: WorkReleaseDeps = {
  client: async (scope, repository) =>
    createGitHubClient({
      token: await resolveGitHubToken({
        ...scope,
        connectionId: repository.connectionId,
      }),
    }),
};

function stateOf(release: GitHubRelease): NonNullable<RunRelease["state"]> {
  if (release.draft) return "draft";
  if (release.prerelease) return "prerelease";
  return "published";
}

/**
 * The session's releases, one per repository and tag at the first frame that
 * created it, in frame order, with GitHub's state for each. Each repository
 * is read once, however many of its releases the session created.
 *
 * Warnings: `release_repository_unknown` (a release whose repository the
 * record does not resolve, left out, since a row with no repository names a
 * release nobody can find), `recorded_repository_not_connected`,
 * `release_not_found`, `release_list_limit` (the tag is past GitHub's first
 * 100 releases), `release_read_failed`, `release_limit` (more than 20), and
 * `release_frame_limit` (the frame read stopped at its cap).
 */
export async function readWorkReleases(
  scope: RunScope,
  frames: readonly CommandRefFrameRow[],
  checkouts: readonly RunCheckout[],
  repositories: readonly ConnectedRunRepository[],
  deps: WorkReleaseDeps = defaultWorkReleaseDeps,
): Promise<{ releases: RunRelease[]; warnings: string[] }> {
  const warnings = new Set<string>();
  if (frames.length > COMMAND_REF_FRAME_CAP) warnings.add("release_frame_limit");
  const releases: RunRelease[] = [];
  const seen = new Set<string>();
  for (const row of frames.slice(0, COMMAND_REF_FRAME_CAP)) {
    for (const ref of releaseRefsOfFrame(row)) {
      const repository = resolveFrameRepository(
        ref.repository,
        row.path,
        checkouts,
        repositories,
      );
      if (repository === null) {
        warnings.add("release_repository_unknown");
        continue;
      }
      const key = `${repository.url.toLowerCase()}@${ref.tag}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (releases.length >= RUN_RELEASE_MAX) {
        warnings.add("release_limit");
        continue;
      }
      releases.push({
        repository,
        tag: ref.tag,
        name: null,
        url: null,
        state: null,
        frameSeq: String(row.seq),
        observedAt: chInstant(row.observed_at),
      });
    }
  }
  const lists = new Map<string, Promise<GitHubRelease[]>>();
  for (const release of releases) {
    const connected = connectionOf(release.repository, repositories);
    if (connected === undefined) {
      warnings.add("recorded_repository_not_connected");
      continue;
    }
    let list = lists.get(connected.url);
    if (list === undefined) {
      list = deps
        .client(scope, connected)
        .then((gh) =>
          gh.listReleases({ owner: connected.owner, repo: connected.name }),
        );
      lists.set(connected.url, list);
    }
    let listed: GitHubRelease[];
    try {
      listed = await list;
    } catch (error) {
      logger.warn(
        { err: error, orgId: scope.orgId, workspaceId: scope.workspaceId },
        "Run release state could not be read",
      );
      warnings.add("release_read_failed");
      continue;
    }
    const found = listed.find((candidate) => candidate.tagName === release.tag);
    if (found === undefined) {
      warnings.add(
        listed.length >= RELEASE_PAGE ? "release_list_limit" : "release_not_found",
      );
      continue;
    }
    release.name = found.name;
    release.url = found.htmlUrl;
    release.state = stateOf(found);
  }
  return { releases, warnings: [...warnings] };
}
