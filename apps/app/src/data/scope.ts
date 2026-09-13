// The tenant a read runs under. Structurally identical to `Scope` in
// src/server/scope.ts (lane L4), which builds it from the signed-in viewer;
// the data layer declares its own so it never imports the server seams.
export type Scope = {
  /** `org.organizations.id` (uuid). */
  orgId: string;
  /** `wrk.workspaces.id` (uuid), or the all-zero uuid on organization pages. */
  workspaceId: string;
};

/** The workspace id organization-scoped pages carry. */
export const ORG_ONLY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";
