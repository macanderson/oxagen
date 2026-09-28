"use server";
// The steering repo writes (#4518). The platform has registered neither, so
// each is a local contract under the name the platform will register. The
// kernel answers `unavailable` with code `tool_not_registered` today, and the
// same call reaches the handler, unchanged, once the capability lands. The
// schemas are the proposed shapes, and the platform contract replaces each.
import { z } from "zod";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { REPO_HEALTH_STATES, type RepoHealth } from "./types";

const retrySteeringRepoProvisionContract = {
  name: "retry_steering_repo_provision",
  input: z.object({}).strict(),
  output: z.object({
    status: z.enum(["provisioning", "ready", "failed", "blocked"]),
  }),
};

const repairSteeringRepoContract = {
  name: "repair_steering_repo",
  input: z.object({}).strict(),
  output: z.object({ health: z.enum(REPO_HEALTH_STATES) }),
};

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
  return kernelWrite(ctx, retrySteeringRepoProvisionContract, {});
}

/** Put every prescribed setting back on the workspace's steering repo. The answer is the health after the repair. */
export async function repairSteeringRepo(
  org: string,
  ws: string,
): Promise<ActionResult<{ health: RepoHealth }>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, repairSteeringRepoContract, {});
}
