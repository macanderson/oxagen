// Who `dispatch_command` admits: an organization Owner or Admin, or a
// workspace Owner or Member. The rule is the contract's `defaultRoles`
// (packages/oxagen/src/contracts/tacho.command.dispatch.ts).
//
// Two pages gate on it. The run's own header draws four controls, and a run's
// row on Fleet draws three. A copy in each lane is a copy that can drift, and
// the way it fails is a page offering a button whose only outcome is
// `org_role_required`. So it is written once, here, where both may read it.
//
// The other run writes keep their rules here for the same reason: `seal_run`
// (`canSealRun`) and `fork_run` (`canForkRun`), whose Fork button the header
// and the Chain tab both draw.
//
// The roles arrive as strings. A rule that classifies a role value needs no
// edge to the viewer seam, and this layer has none (ARCHITECTURE.md §2); the
// callers pass `ctx.orgRole` and `ctx.wsRole`, which the compiler types.

const COMMANDING_ORG_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const COMMANDING_WS_ROLES: ReadonlySet<string> = new Set(["owner", "member"]);

/** Whether this viewer may queue a command for a run in this workspace. */
export function canCommandRun(orgRole: string, wsRole: string): boolean {
  return COMMANDING_ORG_ROLES.has(orgRole) || COMMANDING_WS_ROLES.has(wsRole);
}

/**
 * Whether this viewer may seal a run (`seal_run`, ADR-169): an organization
 * Owner or Admin, or the workspace's Owner. A workspace Member can stop an
 * agent with Cancel, but sealing also closes the record, so it is not theirs.
 */
export function canSealRun(orgRole: string, wsRole: string): boolean {
  return COMMANDING_ORG_ROLES.has(orgRole) || wsRole === "owner";
}

const FORKING_ORG_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "member",
]);

/**
 * Whether this viewer may fork a run (`fork_run`): an organization Owner,
 * Admin or Member. The handler checks the organization role alone
 * (`FORK_ROLES` in packages/handlers/src/run.fork.ts), so a workspace Owner
 * whose organization role is Viewer can read the run and still cannot fork
 * it.
 */
export function canForkRun(orgRole: string): boolean {
  return FORKING_ORG_ROLES.has(orgRole);
}
