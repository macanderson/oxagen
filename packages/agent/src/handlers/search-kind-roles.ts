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
import {
  actsInWorkspace,
  workspaceFullAccessRole,
} from "@oxagen/oxagen/iam";

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
const SEARCH_KIND_SOURCES = {
  run: runList,
  agent: agentList,
  approval: agentApprovalList,
} as const satisfies Partial<Record<SearchKind, unknown>>;

export const SEARCH_KIND_ROLES: Readonly<
  Partial<Record<SearchKind, KindRoles>>
> = {
  run: rolesOf(SEARCH_KIND_SOURCES.run),
  agent: rolesOf(SEARCH_KIND_SOURCES.agent),
  approval: rolesOf(SEARCH_KIND_SOURCES.approval),
};

/**
 * Whether an actor holding these roles may see this kind. A kind with no
 * source capability (`tool`) is always allowed — `search_tools`' own gate has
 * already run in the kernel by the time a handler executes.
 *
 * A workspace's Owner or Admin sees every kind whose source capability acts
 * inside the workspace, as that capability's own gate would admit them
 * (#5228). An agent run gets no such pass: `agentRun` says the call is one.
 */
export function maySeeKind(
  kind: SearchKind,
  actor: {
    orgRoles: readonly string[];
    workspaceRoles: readonly string[];
    agentRun?: boolean;
  },
): boolean {
  const required = SEARCH_KIND_ROLES[kind];
  if (!required) return true;
  if (actor.orgRoles.some((r) => required.org.includes(r))) return true;
  if (actor.workspaceRoles.some((r) => required.workspace.includes(r))) {
    return true;
  }
  const source =
    SEARCH_KIND_SOURCES[kind as keyof typeof SEARCH_KIND_SOURCES];
  return (
    actor.agentRun !== true &&
    source !== undefined &&
    actsInWorkspace(source) &&
    workspaceFullAccessRole(actor.workspaceRoles) !== null
  );
}
