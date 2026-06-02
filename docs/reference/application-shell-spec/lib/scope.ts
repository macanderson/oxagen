export type ShellMode = "workspace" | "org" | "account" | "pre-shell"

export type ScopeContext = {
  org?: string
  ws?: string
}

const RESERVED_ORG_SEGMENTS = new Set(["account", "ask"])

/**
 * Derive the navigation mode and scope from a pathname.
 * The URL is the single source of nav truth (spec §10).
 */
export function resolveScope(pathname: string): {
  mode: ShellMode
  scope: ScopeContext
} {
  const segments = pathname.split("/").filter(Boolean)

  if (segments.length === 0) {
    return { mode: "pre-shell", scope: {} }
  }

  if (segments[0] === "account") {
    return { mode: "account", scope: {} }
  }

  if (segments[0] === "ask") {
    return { mode: "pre-shell", scope: {} }
  }

  if (RESERVED_ORG_SEGMENTS.has(segments[0])) {
    return { mode: "pre-shell", scope: {} }
  }

  const org = segments[0]

  // /{org}/{ws}/... is workspace mode unless the second segment is an org-level surface
  const ORG_SURFACES = new Set([
    "workspaces",
    "members",
    "access",
    "security",
    "billing",
    "developer",
  ])

  if (segments.length >= 2 && !ORG_SURFACES.has(segments[1])) {
    return { mode: "workspace", scope: { org, ws: segments[1] } }
  }

  return { mode: "org", scope: { org } }
}

/**
 * Build the target path when switching organizations.
 * In org mode the current surface + tab is preserved across orgs
 * (e.g. /acme/access/identities -> /globex/access/identities).
 * Workspaces are org-specific, so workspace-mode switches fall back to the
 * new org root, which redirects to its first/last-viewed workspace.
 */
export function buildOrgSwitchPath(pathname: string, newOrg: string): string {
  const { mode } = resolveScope(pathname)
  const segments = pathname.split("/").filter(Boolean)

  if (mode === "org") {
    const rest = segments.slice(1)
    return "/" + [newOrg, ...rest].join("/")
  }

  return `/${newOrg}`
}

/**
 * Build the target path when switching workspaces within the same org.
 * The active destination + tab is preserved
 * (e.g. /acme/production/knowledge/sources -> /acme/design/knowledge/sources).
 */
export function buildWorkspaceSwitchPath(
  pathname: string,
  org: string,
  newWs: string,
): string {
  const { mode } = resolveScope(pathname)
  const segments = pathname.split("/").filter(Boolean)

  if (mode === "workspace") {
    const rest = segments.slice(2)
    return "/" + [org, newWs, ...rest].join("/")
  }

  return `/${org}/${newWs}`
}
