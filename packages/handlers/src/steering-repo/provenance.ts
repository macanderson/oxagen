import { HandlerError } from "@oxagen/oxagen";
import type { SteeringHost, SteeringRepository } from "../context.steering.github";

/** Verify a captured commit before its files change live steering state. */
export async function assertSteeringCommit(
  host: SteeringHost,
  repo: SteeringRepository,
  commit: string,
  requireGithubVerifier = false,
): Promise<void> {
  if (host.assertSteeringCommit) {
    await host.assertSteeringCommit(repo, commit);
    return;
  }
  if (
    repo.provider === "github" &&
    (repo.requiresSteeringProvenance || requireGithubVerifier)
  ) {
    throw new HandlerError({
      code: "conflict",
      reason: "steering_provenance_unavailable",
      message: `Oxagen cannot verify who merged ${commit} in ${repo.fullName}. Retry after the repository connection is repaired.`,
    });
  }
}
