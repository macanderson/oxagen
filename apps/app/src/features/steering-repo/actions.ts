"use server";
// The steering repo writes (#4518). Repair calls the platform contract
// `repair_steering_repo` (lane S2, #4560), and retry calls
// `retry_steering_repo_provision` (#4750).
import { steeringRepoRepair } from "@oxagen/oxagen/contracts/steering_repo.repair";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import type { RepoHealth } from "./types";

/**
 * Run the provisioning job again from the step that failed or stopped. Before
 * the organization has a workspace (`ws` null), the job belongs to the
 * organization, so the call runs as the organization viewer.
 */
export async function retrySteeringRepoProvision(
  org: string,
  ws: string | null,
): Promise<
  ActionResult<{ status: "provisioning" | "ready" | "failed" | "blocked" }>
> {
  const ctx =
    ws === null ? await requireViewer(org) : await requireViewer(org, ws);
  return kernelWrite(ctx, steeringRepoProvisionRetry, {});
}

/** Put every prescribed setting back on the workspace's steering repo. The answer is the health after the repair. */
export async function repairSteeringRepo(
  org: string,
  ws: string,
): Promise<ActionResult<{ health: RepoHealth }>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, steeringRepoRepair, {});
}
