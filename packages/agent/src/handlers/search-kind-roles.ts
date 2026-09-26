/**
 * Which IAM roles may see each kind `search_tools` searches, read from the
 * contract of the capability that authoritatively lists that kind.
 *
 * `search_tools` queries the run, agent and approval tables directly rather
 * than invoking `list_runs`, `list_agents` and `list_approvals`, so without
 * this it answered under its OWN roles, which are broader. A workspace
 * `Viewer` is allowed `search_tools` and denied `list_runs` and
 * `list_agents`, so `kinds: ["run"]` and `kinds: ["agent"]` handed a viewer
 * run ids and goals, and agent names, slugs and statuses, that the
 * authoritative capabilities refuse them.
 *
 * The lists are DERIVED from each source contract's `defaultRoles` rather
 * than restated here, so tightening `list_runs` tightens search in the same
 * commit and cannot drift. This is the same shape as
 * `approval-roles.ts`, for the same reason: a control written out a second
 * time at a second call site is a control the next call site will not have.
 */
import { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import { agentList } from "@oxagen/oxagen/contracts/agent.list";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import type { SearchKind } from "@oxagen/oxagen/contracts/tools.search";

/** The org and workspace roles a capability's contract grants `allow`. */
export interface KindRoles {
  readonly org: readonly string[];
  readonly workspace: readonly string[];
}

function allowedRoles(
  grants: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  return Object.entries(grants ?? {})
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

function rolesOf(contract: {
  defaultRoles?: {
    org?: Readonly<Record<string, string | undefined>>;
    workspace?: Readonly<Record<string, string | undefined>>;
  };
}): KindRoles {
  return {
    org: allowedRoles(contract.defaultRoles?.org),
    workspace: allowedRoles(contract.defaultRoles?.workspace),
  };
}

/**
 * Kind → the capability that owns it. `tool` has no entry: the belt is not a
 * workspace table, it is the capability registry filtered by the org's plugin
 * entitlements, and `search_tools`' own roles are the right gate for it.
 */
export const SEARCH_KIND_ROLES: Readonly<
  Partial<Record<SearchKind, KindRoles>>
> = {
  run: rolesOf(runList),
  agent: rolesOf(agentList),
  approval: rolesOf(agentApprovalList),
};

/**
 * Whether an actor holding these roles may see this kind. A kind with no
 * source capability (`tool`) is always allowed — `search_tools`' own gate has
 * already run in the kernel by the time a handler executes.
 */
export function maySeeKind(
  kind: SearchKind,
  actor: { orgRoles: readonly string[]; workspaceRoles: readonly string[] },
): boolean {
  const required = SEARCH_KIND_ROLES[kind];
  if (!required) return true;
  if (actor.orgRoles.some((r) => required.org.includes(r))) return true;
  return actor.workspaceRoles.some((r) => required.workspace.includes(r));
}
