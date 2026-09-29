// steering-repo/first-version.ts: publish a new steering repo's first commit
// through the version store (#4732).
//
// Provisioning records version 1 as a host deployment in publish_version, but
// the version store is what numbers every later publish. Before #4732 the
// store stayed empty until the first repository sync, so a steering PR merged
// before that sync took version 1 as well: two commits, one version. Once
// bind_repository has bound the repository, it calls publishFirstVersion, so
// the store holds the first commit as version 1 and the first steering PR
// publishes version 2.
//
// The publish goes through the repository sync's port, `SyncPublish`, which
// resolves the steering repo from the binding this step just wrote. A rerun
// finds the head already published and answers `current`.
import type { SyncPublish, SyncPublished } from "../context.steering.sync";
import { logger } from "../logger";

/** The workspace whose steering repo was just bound. */
export interface FirstVersionScope {
  orgId: string;
  workspaceId: string;
}

/**
 * Publish the steering repo's production head as its first version.
 *
 * - `published` and `current` log the version and return the answer.
 * - `stale` throws, so the step fails and the job retries it: the branch
 *   moved during the publish, and the store holds nothing yet.
 * - `refused` logs a warning and returns the answer. The repository is not
 *   healthy, so no publish passes until a person repairs it, and the sync
 *   publishes after the repair.
 * - A null answer logs a warning and returns null: the repository does not
 *   read as the steering layout, so there is no bundle to publish.
 * - An error from the port propagates, so the step fails and retries.
 *
 * Without a port, as in tests that do not exercise the publish, nothing is
 * published and the answer is null.
 */
export async function publishFirstVersion(
  publish: SyncPublish | undefined,
  scope: FirstVersionScope,
  repository: string,
): Promise<SyncPublished | null> {
  if (publish === undefined) return null;
  const out = await publish({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
  });
  const fields = {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    repository,
  };
  if (out === null) {
    logger.warn(
      fields,
      "steering_repo.provision: the bound repository does not read as a steering repo, so its first commit was not published",
    );
    return null;
  }
  switch (out.status) {
    case "published":
    case "current":
      logger.info(
        { ...fields, status: out.status, version: out.version },
        "steering_repo.provision: published the first steering version",
      );
      return out;
    case "refused":
      logger.warn(
        { ...fields, status: out.status },
        "steering_repo.provision: the steering repo is not healthy, so its first commit was not published; the repository sync publishes it after a repair",
      );
      return out;
    case "stale":
      throw new Error(
        `The production branch of ${repository} moved while its first commit was published, so the step runs again.`,
      );
  }
}
