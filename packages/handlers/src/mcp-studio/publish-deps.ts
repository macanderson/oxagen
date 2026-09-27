// publish-deps.ts: binds MCP Studio's project() into a steering publish
// (M13, #4478, ADR-209).
//
// `@oxagen/steering-bundle` builds and stores a version, but it cannot import
// this package, so its publish() takes project() as a dependency. A publisher
// builds its deps through `withToolProjection`, and then every version it
// publishes writes the workspace's tool registry before the version goes live.
// When storing the version fails after that, publish() projects the published
// version back through the same function.
import type { PublishDeps } from "@oxagen/steering-bundle";
import { project } from "./project";

/**
 * Returns `deps` with `project` set to MCP Studio's project(). The folder list
 * publish() reads from the merged tree goes through unchanged. The rows
 * project() stamps take their time from `deps.now`, the clock publish() uses
 * for the version's `published_at`.
 */
export function withToolProjection(
  deps: Omit<PublishDeps, "project">,
): PublishDeps {
  return {
    ...deps,
    project: async (bundle, options) => {
      await project(bundle, { folders: options?.folders, now: deps.now() });
    },
  };
}
