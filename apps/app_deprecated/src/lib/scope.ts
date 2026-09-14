/**
 * ScopeContext — the two slugs that identify the current org and (optionally)
 * workspace. All route builders and sidebar href functions take this shape so
 * they never have to re-parse the URL themselves.
 *
 * Both values are URL slugs, not database IDs.
 */
export type ScopeContext = {
  orgSlug: string;
  workspaceSlug?: string;
};
