// steering.search.ts: the steering_search MCP tool (steering-repo-spec, Agent
// use).
//
// An agent calls it to find steering the run's index did not list, or to find
// the lineage behind an index line before it reads the record. It searches
// the two published versions the caller's workspace reads: the workspace's
// steering repo and the organization repo. A workspace with neither version
// published gets no hits and null versions, not an error, so the agent's
// next step reads the same either way.
//
// A call from a run searches the two versions that run was delivered, so a
// version that publishes during the run does not change what the run reads.
// steering_read does the same.
//
// The handler is a factory. Its default instance waits for two things other
// lanes own: the steering_search contract in packages/oxagen/src/contracts,
// and the version store `published` reads (#4447).
import type { CheckedContext } from "@oxagen/oxagen";
import {
  searchSteering,
  steeringSearchInputSchema,
  type Delivery,
  type SteeringSearchOutput,
} from "@oxagen/steering-bundle";

/** The workspace a steering read answers for, and the run that asks, if any. */
export interface SteeringScope {
  orgId: string;
  workspaceId: string;
  /** The run the call belongs to, or null for a call from outside a run. */
  runId: string | null;
}

/**
 * The published versions a workspace reads: its steering repo's and its
 * organization's. Either is null until its first version publishes.
 *
 * With a run id, these are the two versions the run's request manifest names
 * (`workspace_version` and `organization_version`), even after a newer
 * version publishes. Without one, they are the versions published now.
 */
export type ReadPublished = (scope: SteeringScope) => Promise<Delivery>;

export interface SteeringSearchDeps {
  published: ReadPublished;
}

export type SteeringSearchHandler = (
  input: unknown,
  ctx: CheckedContext,
) => Promise<SteeringSearchOutput>;

/** The caller's scope, from the checked context. */
export function steeringScope(ctx: CheckedContext): SteeringScope {
  return { orgId: ctx.orgId, workspaceId: ctx.workspaceId, runId: ctx.runId ?? null };
}

export function createSteeringSearchHandler(
  deps: SteeringSearchDeps,
): SteeringSearchHandler {
  return async (input, ctx) => {
    const parsed = steeringSearchInputSchema.parse(input);
    const delivery = await deps.published(steeringScope(ctx));
    return searchSteering(delivery, parsed);
  };
}
