// workspace-authority.ts — the rule that lets a workspace's Owner and Admin do
// everything in that workspace (#5228).
//
// Mac decided on 2026-10-02 that a workspace's Owner and Admin see and do
// everything in their workspace, and gain nothing outside it. Access used to
// be decided capability by capability, and most contracts left the workspace
// roles out of `defaultRoles`, so a workspace's owner was refused much of the
// workspace they owned.
//
// The rule:
//
//   A human who holds the system workspace role Owner or Admin on the call's
//   workspace passes the role check of every capability that acts inside
//   that workspace.
//
// Every seam that decides a role applies it through the functions below:
//
//   - `assertOrgRole` (packages/iam/src/org-role.ts), the gate a handler runs
//   - rule 7.6 of `resolve()` (./resolve.ts), the kernel's IAM check for
//     Enterprise orgs
//   - `assertCallerRole` (packages/handlers/src/lib/capability-role-guard.ts),
//     the older gate that reads the membership columns
//   - `contractGrantsCaller` (packages/agent/src/runtime/toolbelt.ts), which
//     decides the tools Stella offers a person
//
// What it does not grant:
//
//   - An org-level capability. Its contract carries `orgLevel: true`, and the
//     rule skips it: billing, org settings, org membership, and other
//     workspaces still need an org role.
//   - Another workspace. The role must be held on the call's own workspace,
//     and a call with no real workspace (`ORG_ONLY_WORKSPACE_ID`) holds no
//     workspace role.
//   - Anything to an agent. Each seam leaves agent runs out, so an agent's
//     delegation ceiling is computed exactly as before.
//
// An explicit restriction still wins where one exists: a role grant with
// effect `deny` or `require_approval` decides before rule 7.6, as it does
// before the org Owner's rule 7.5. A handler gate that guards an org-level or
// cross-workspace step inside a workspace capability says so with
// `namedRolesOnly` on its requirement (org-role.ts).

import { ORG_ONLY_WORKSPACE_ID, type CapabilityDeclaration } from "../types";

/** The system workspace roles that pass every role check in their workspace. */
export const WORKSPACE_FULL_ACCESS_ROLES = ["Owner", "Admin"] as const;

export type WorkspaceFullAccessRole =
  (typeof WORKSPACE_FULL_ACCESS_ROLES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `workspaceId` names a real workspace: a uuid that is not the
 * org-only sentinel (ADR-068). An empty id, a non-uuid, and the sentinel all
 * name none.
 */
export function isRealWorkspaceId(
  workspaceId: string | null | undefined,
): workspaceId is string {
  return (
    typeof workspaceId === "string" &&
    UUID_RE.test(workspaceId) &&
    workspaceId !== ORG_ONLY_WORKSPACE_ID
  );
}

/**
 * Whether a capability acts inside the call's workspace, so that the
 * workspace's Owner and Admin pass its role check. False for a contract
 * marked `orgLevel` and for a `platformOnly` one, which no organization
 * reaches.
 */
export function actsInWorkspace(
  // `name` is required so a contract's own literal type, which declares
  // neither flag, is accepted: a type of optional fields alone is a "weak"
  // type, and TypeScript refuses an argument that shares no field with it.
  capability: Pick<CapabilityDeclaration, "name" | "orgLevel" | "platformOnly">,
): boolean {
  return capability.orgLevel !== true && capability.platformOnly !== true;
}

/**
 * The role among `roleNames` that grants full access, by IAM role name
 * (`iam.roles.name`, exact case), or null. Owner wins over Admin when the
 * principal holds both.
 */
export function workspaceFullAccessRole(
  roleNames: readonly string[],
): WorkspaceFullAccessRole | null {
  return (
    WORKSPACE_FULL_ACCESS_ROLES.find((name) => roleNames.includes(name)) ??
    null
  );
}

/**
 * The same test for a membership column (`workspace.workspace_users.role`),
 * which is written in both casings. Returns the IAM role name it stands for.
 */
export function membershipFullAccessRole(
  membershipRole: string | null | undefined,
): WorkspaceFullAccessRole | null {
  const lower = membershipRole?.toLowerCase();
  if (lower === "owner") return "Owner";
  if (lower === "admin") return "Admin";
  return null;
}
