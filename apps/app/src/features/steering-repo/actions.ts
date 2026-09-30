"use server";
// The steering repo writes (#4518). Repair calls the platform contract
// `repair_steering_repo` (lane S2, #4560), retry calls
// `retry_steering_repo_provision` (#4750), and the setup of a workspace made
// before steering repos existed calls `import_workspace_steering` (#4875).
import {
  steeringRepoImport,
  type SteeringRepoImportOutput,
} from "@oxagen/oxagen/contracts/steering_repo.import";
import { steeringRepoRepair } from "@oxagen/oxagen/contracts/steering_repo.repair";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import type { RepoHealth, SteeringConnectionPick } from "./types";

/**
 * Run the provisioning job again from the step that failed or stopped. Before
 * the organization has a workspace (`ws` null), the job belongs to the
 * organization, so the call runs as the organization viewer. `connection` is
 * the one a person picked after setup stopped with `choose_connection`.
 */
export async function retrySteeringRepoProvision(
  org: string,
  ws: string | null,
  connection?: SteeringConnectionPick,
): Promise<
  ActionResult<{ status: "provisioning" | "ready" | "failed" | "blocked" }>
> {
  const ctx =
    ws === null ? await requireViewer(org) : await requireViewer(org, ws);
  return kernelWrite(
    ctx,
    steeringRepoProvisionRetry,
    connection === undefined ? {} : { connection },
  );
}

/**
 * Create the workspace's steering repo through the import: it moves the
 * `.oxagen/` steering of a code repository that still steers the workspace,
 * or only creates the repo when there is none. The run provisions inline, so
 * the answer comes once the repo exists or setup stopped.
 */
export async function importWorkspaceSteering(
  org: string,
  ws: string,
  connection?: SteeringConnectionPick,
): Promise<ActionResult<SteeringRepoImportOutput>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(
    ctx,
    steeringRepoImport,
    connection === undefined ? {} : { connection },
  );
}

/** Put every prescribed setting back on the workspace's steering repo. The answer is the health after the repair. */
export async function repairSteeringRepo(
  org: string,
  ws: string,
): Promise<ActionResult<{ health: RepoHealth }>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, steeringRepoRepair, {});
}
