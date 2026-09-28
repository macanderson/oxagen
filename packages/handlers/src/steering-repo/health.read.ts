// The health read the merge and publish guards use (S2, #4560).
//
// A workspace whose steering repo is drifted, disconnected, or diverged
// merges nothing and publishes nothing until it is repaired. This module
// only binds the guards' seam to the stored health, and loads ./health on
// the first call so the merge and sync modules do not load the host
// clients at import.
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import type { SteeringRepository } from "../context.steering.github";
import type { VersionScope } from "./version-store";

/**
 * The workspace's steering repo health, as the last read stored it. The
 * guards pass the repository they resolved. The read goes by the workspace,
 * because a workspace has one steering repo and the binding's name can lag
 * a rename on the host.
 */
export async function readSteeringHealth(
  _repo: SteeringRepository,
  scope: VersionScope,
): Promise<RepoHealth> {
  const { readRepoHealth } = await import("./health");
  return readRepoHealth({ orgId: scope.orgId, workspaceId: scope.workspaceId });
}
