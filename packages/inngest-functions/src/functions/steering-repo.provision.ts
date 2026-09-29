import { NonRetriableError } from "@oxagen/functions";

import { createFunction } from "../create-function";
import {
  steeringRepoProvisionRunner,
  type SteeringRepoProvisionScope,
  type SteeringRepoStepResult,
} from "../lib/steering-repo-provision-runner";

/**
 * One step, with a refusal the runner flagged non-retriable rethrown as the
 * error Inngest recognises inside a step. A missing authorization or a taken
 * name reads the same on every retry, so the job stops and the workspace
 * shows which step stopped and why.
 */
async function runStep(
  scope: SteeringRepoProvisionScope,
  step: string,
): Promise<SteeringRepoStepResult> {
  try {
    return await steeringRepoProvisionRunner().runStep(scope, step);
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      (err as { isNonRetriable?: unknown }).isNonRetriable === true
    )
      throw new NonRetriableError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    throw err;
  }
}

/**
 * Provision a steering repo (steering-repo-spec, Provisioning; lane S1).
 *
 * `create_workspace` sends `steering-repo/provision.requested` for the new
 * workspace, and `create_organization` sends it for `<org>/oxagen`. The
 * headless backfill (`steering-repo.backfill.ts`, #4683) sends it for each
 * workspace that never started provisioning. Each step
 * is its own durable step, so a retry starts at the step that failed. Every
 * step also reads what earlier runs recorded, so sending the event again for
 * the same scope finishes the work instead of repeating it.
 */
export const [steeringRepoProvision] = createFunction(
  {
    id: "steering-repo/provision",
    retries: 4,
    // One run per organization at a time. Two new workspaces in one org would
    // otherwise both pick the org's connection, and both write it.
    concurrency: { limit: 1, key: "event.data.orgId" },
  },
  { event: "steering-repo/provision.requested" },
  async ({ event, step }) => {
    const data = event.data as {
      orgId: string;
      workspaceId?: string | null;
      actorUserId: string;
    };
    const scope: SteeringRepoProvisionScope = {
      orgId: data.orgId,
      workspaceId: data.workspaceId ?? null,
      actorUserId: data.actorUserId,
    };
    const steps = await steeringRepoProvisionRunner().steps();
    let last: SteeringRepoStepResult | null = null;
    for (const name of steps)
      last = await step.run(name, () => runStep(scope, name));
    return { status: last?.status ?? "provisioning" };
  },
);
