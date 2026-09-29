// audit-exempt: read-only — reports which repository layout the workspace's
// bound repository uses. Mutates nothing. The kernel capability.invoke_*
// audit covers access.
//
// get_steering_layout (#4765): the same read open_context_pr makes before it
// writes a record file (readSteeringLayout, steering-repo/merge-queue.ts), so
// a client can preview the path and branch it will actually write. Answers
// `layout: null`, never a guess, when no repository is bound or the read
// fails — a wrong preview is worse than none, and open_context_pr would
// refuse the write on the same failure.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  contextSteeringLayout,
  type ContextSteeringLayoutOutput,
} from "@oxagen/oxagen/contracts/context.steering.layout";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { readSteeringLayout } from "./steering-repo/merge-queue";

export function createGetSteeringLayoutHandler(
  deps: Pick<SteeringDeps, "github">,
): CapabilityHandler<typeof contextSteeringLayout> {
  return async (_input, ctx): Promise<ContextSteeringLayoutOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const repo = await deps.github.resolveRepository(scope).catch(() => null);
    if (repo === null) return { layout: null };
    const read = await readSteeringLayout(deps.github, repo).catch(
      () => null,
    );
    return { layout: read?.layout ?? null };
  };
}

export const getSteeringLayoutHandler = createGetSteeringLayoutHandler(
  steeringDeps(),
);
