// audit-exempt: read-only — reads a scope's pull requests from the forge store; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// get_change_set (ADR-292): the pull requests a run, a work order, a work
// item, or an issue produced, each with its latest stored revision, and their
// change rolled up by repository. lib/forge-pull-requests/read.ts resolves
// the scope through the forge link tables and the older stores that still
// name links, and nothing here reads GitHub or GitLab.
import { withTenantDb } from "@oxagen/database";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import type {
  ChangeSetGetOutput,
  ChangeSetScope,
} from "@oxagen/oxagen/contracts/forge.changes.get";
import {
  CHANGE_SET_ID_PATTERNS,
  changeSetGet,
} from "@oxagen/oxagen/contracts/forge.changes.get";
import { readChangeSet } from "./lib/forge-pull-requests/read";

export type ChangeSetGetDeps = {
  read(
    scope: { orgId: string; workspaceId: string },
    kind: ChangeSetScope,
    id: string,
  ): Promise<ChangeSetGetOutput | "not_found">;
};

export function createGetChangeSetHandler(
  deps: ChangeSetGetDeps,
): CapabilityHandler<typeof changeSetGet> {
  return async (input, ctx) => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const out = CHANGE_SET_ID_PATTERNS[input.scope].test(input.id)
      ? await deps.read(scope, input.scope, input.id)
      : "not_found";
    if (out === "not_found")
      throw new HandlerError({
        code: "not_found",
        reason: `${input.scope}_not_found`,
        message: `No ${input.scope.replace("_", " ")} ${input.id} in this workspace`,
      });
    return out;
  };
}

export const getChangeSetHandler = createGetChangeSetHandler({
  read: (scope, kind, id) =>
    withTenantDb((tx) => readChangeSet(tx, scope, kind, id)),
});
