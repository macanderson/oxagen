// The app's copy of the workspace Owner and Admin rule (#5228).
//
// Mac decided on 2026-10-02 that a workspace's Owner and Admin can do
// everything in that workspace, and nothing outside it. The server applies the
// rule at every role gate (packages/oxagen/src/iam/workspace-authority.ts). A
// page that hides a control by role asks these two functions, so it offers a
// workspace's Owner and Admin what the server will let them do.
//
// Use them only for a capability that acts inside the workspace. An org-level
// capability (its contract carries `orgLevel: true`) and an org-only step
// inside a workspace capability still read the org role alone.
//
// The roles arrive as strings, because this layer may not import the viewer
// seam (ARCHITECTURE.md §2). Callers pass `ctx.orgRole` and `ctx.wsRole`.

const FULL_ACCESS_WS_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * Whether this workspace role is the workspace's Owner or Admin. The
 * membership column is written in both casings, so the match ignores case.
 */
export function holdsWorkspaceAuthority(
  wsRole: string | null | undefined,
): boolean {
  return (
    typeof wsRole === "string" && FULL_ACCESS_WS_ROLES.has(wsRole.toLowerCase())
  );
}

/**
 * Whether this viewer may use a workspace capability: they hold one of
 * `orgRoles`, the org roles the capability names, or they are the
 * workspace's Owner or Admin.
 */
export function mayActInWorkspace(
  orgRole: string,
  wsRole: string | null | undefined,
  orgRoles: readonly string[],
): boolean {
  return orgRoles.includes(orgRole) || holdsWorkspaceAuthority(wsRole);
}
