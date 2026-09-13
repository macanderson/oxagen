// The tenant scope every read port and write takes (plan §4.6). Kept apart from
// scope.ts so pure modules (cache tags, ports, tests) can name it without
// pulling in the session and navigation seams.

/** Organization and workspace ids (UUIDs), as `runInTenantScope` takes them. */
export type Scope = { readonly orgId: string; readonly workspaceId: string };

/**
 * The workspace id an organization-level page runs under. Organization-scoped
 * tables (`org_only` under RLS) ignore the workspace GUC; the sentinel keeps
 * `runInTenantScope`'s UUID assertion satisfied without naming a real workspace.
 */
export const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

export function isOrgOnlyScope(scope: Scope): boolean {
  return scope.workspaceId === ORG_ONLY_WS;
}
