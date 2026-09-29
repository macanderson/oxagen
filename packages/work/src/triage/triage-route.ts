// triage-route.ts: the model route triage drafts with.
//
// The model that drafts a done record never implements the item
// (agent-work-spec.html, A second model). work.toml lists the triage routes in
// order, and triage uses the first one that no build stage pins. Triage runs
// before it knows the item's workflow, so it avoids the build pins of every
// workflow in the workspace. A stage with no kind reads as build, which covers
// v0.1 and v0.2 files.
import type { Workflow } from "../types";

/** Every triage route is pinned on a build stage, or work.toml lists none. */
export class TriageRouteError extends Error {
  readonly code = "triage_route_pinned";
  constructor(
    readonly routes: readonly string[],
    readonly pinned: readonly string[],
  ) {
    super(
      routes.length === 0
        ? "work.toml lists no triage model route. Add one to [triage] models."
        : `Every triage model route (${routes.join(", ")}) is pinned on a build stage. Add a route to [triage] models that no build stage pins.`,
    );
    this.name = "TriageRouteError";
  }
}

/** The model routes pinned on build stages, across the given workflows. */
export function pinnedBuildRoutes(workflows: readonly Pick<Workflow, "stage">[]): Set<string> {
  const pinned = new Set<string>();
  for (const workflow of workflows) {
    for (const stage of workflow.stage) {
      if ((stage.kind ?? "build") === "build" && stage.model !== undefined) pinned.add(stage.model);
    }
  }
  return pinned;
}

/** The first route that no build stage pins. Throws TriageRouteError when there is none. */
export function selectTriageRoute(routes: readonly string[], workflows: readonly Pick<Workflow, "stage">[]): string {
  const pinned = pinnedBuildRoutes(workflows);
  const route = routes.find((candidate) => !pinned.has(candidate));
  if (route === undefined) throw new TriageRouteError(routes, [...pinned]);
  return route;
}
