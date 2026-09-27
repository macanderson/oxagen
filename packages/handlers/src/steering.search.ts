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

/** The workspace a steering read answers for. */
export interface SteeringScope {
  orgId: string;
  workspaceId: string;
}

/**
 * The published versions a workspace reads: its steering repo's and its
 * organization's. Either is null until its first version publishes.
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
  return { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
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
