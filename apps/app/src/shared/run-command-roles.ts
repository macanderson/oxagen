// Who `dispatch_command` admits: an organization Owner or Admin, a workspace
// Member, or the workspace's Owner or Admin. The rule is the contract's
// `defaultRoles` (packages/oxagen/src/contracts/tacho.command.dispatch.ts),
// plus the workspace Owner and Admin rule every workspace capability follows
// (#5228, ./workspace-authority.ts).
//
// Two pages gate on it. The run's own header draws four controls, and a run's
// row on Fleet draws three. A copy in each lane is a copy that can drift, and
// the way it fails is a page offering a button whose only outcome is
// `org_role_required`. So it is written once, here, where both may read it.
//
// The other run writes keep their rules here for the same reason: `seal_run`
// (`canSealRun`), `fork_run` (`canForkRun`), whose Fork button the header
// and the Chain tab both draw, and a path answer to a repository question
// (`canAnswerRepositoryQuestion`). Each admits the workspace's Owner and
// Admin, as the server's gate does.
//
// The roles arrive as strings. A rule that classifies a role value needs no
// edge to the viewer seam, and this layer has none (ARCHITECTURE.md §2); the
// callers pass `ctx.orgRole` and `ctx.wsRole`, which the compiler types.
import { mayActInWorkspace } from "./workspace-authority";

const COMMANDING_ORG_ROLES: readonly string[] = ["owner", "admin"];

/** Whether this viewer may queue a command for a run in this workspace. */
export function canCommandRun(orgRole: string, wsRole: string): boolean {
  return (
    mayActInWorkspace(orgRole, wsRole, COMMANDING_ORG_ROLES) ||
    wsRole === "member"
  );
}

/**
 * Whether this viewer may seal a run (`seal_run`, ADR-169): an organization
 * Owner or Admin, or the workspace's Owner or Admin. A workspace Member can
 * stop an agent with Cancel, but sealing also closes the record, so it is not
 * theirs.
 */
export function canSealRun(orgRole: string, wsRole: string): boolean {
  return mayActInWorkspace(orgRole, wsRole, COMMANDING_ORG_ROLES);
}

/**
 * Whether this viewer may answer a run's repository question with a path
 * (`answer_interjection`, #3941): an organization Owner or Admin, or the
 * workspace's Owner or Admin. A path answer links the repository or creates
 * a workspace, the pair `link_repository` and `create_workspace` admit, so
 * the handler holds a workspace Member to the same pair even though the
 * contract's `defaultRoles` admit a Member for a free-text answer.
 */
export function canAnswerRepositoryQuestion(
  orgRole: string,
  wsRole: string,
): boolean {
  return mayActInWorkspace(orgRole, wsRole, COMMANDING_ORG_ROLES);
}

const FORKING_ORG_ROLES: readonly string[] = ["owner", "admin", "member"];

/**
 * Whether this viewer may fork a run (`fork_run`): an organization Owner,
 * Admin or Member (`FORK_ROLES` in packages/handlers/src/run.fork.ts), or the
 * workspace's Owner or Admin, whom the handler's gate admits too (#5228). A
 * workspace Member whose organization role is Viewer can read the run and
 * still cannot fork it.
 */
export function canForkRun(orgRole: string, wsRole: string): boolean {
  return mayActInWorkspace(orgRole, wsRole, FORKING_ORG_ROLES);
}
