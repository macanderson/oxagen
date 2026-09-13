// The shell's navigation model: the sidebar sections per the baseline mockup
// (Workspace: Fleet, Agent IAM, Tools, Ontology, Steering, Spend; Organization:
// Organization, Billing, Audit), which item is current, and the breadcrumbs.
// Pure functions of the URL, so the sidebar, top bar, command menu and
// <MobileNav> agree on one model.
//
// The mockup's "Scenarios" item is demo chrome, not one of the ten pages
// (spec App. F), so it is not here.
import type { NavCounts } from "./contracts";

export type WorkspaceNavKey =
  | "fleet"
  | "agents"
  | "tools"
  | "ontology"
  | "steering"
  | "spend";
export type OrgNavKey = "organization" | "billing" | "audit";
export type NavKey =
  | WorkspaceNavKey
  | OrgNavKey
  | "apiKeys"
  | "roles"
  | "register";

export const WORKSPACE_NAV: readonly WorkspaceNavKey[] = [
  "fleet",
  "agents",
  "tools",
  "ontology",
  "steering",
  "spend",
];
export const ORG_NAV: readonly OrgNavKey[] = [
  "organization",
  "billing",
  "audit",
];

/**
 * Static segments directly under `/{org}` (Batch 0 route tree). Any other first
 * segment is a workspace slug, which is why workspace slugs must not take these.
 */
export const ORG_SEGMENTS = {
  billing: "billing",
  audit: "audit",
  "api-keys": "apiKeys",
  roles: "roles",
} as const satisfies Record<string, NavKey>;

/** The nav key for a static organization segment, or null when the segment is a workspace slug. */
export function orgSegmentKey(segment: string): NavKey | null {
  return Object.hasOwn(ORG_SEGMENTS, segment)
    ? ORG_SEGMENTS[segment as keyof typeof ORG_SEGMENTS]
    : null;
}

const WORKSPACE_SEGMENT: Record<Exclude<WorkspaceNavKey, "fleet">, string> = {
  agents: "agents",
  tools: "tools",
  ontology: "ontology",
  steering: "steering",
  spend: "spend",
};

const enc = encodeURIComponent;

export function orgHref(org: string, key: NavKey): string {
  const base = `/${enc(org)}`;
  switch (key) {
    case "organization":
      return base;
    case "billing":
    case "audit":
    case "roles":
      return `${base}/${key}`;
    case "apiKeys":
      return `${base}/api-keys`;
    default:
      throw new Error(`${key} is a workspace page, not an organization page`);
  }
}

export function workspaceHref(
  org: string,
  ws: string,
  key: WorkspaceNavKey | "register",
): string {
  const base = `/${enc(org)}/${enc(ws)}`;
  if (key === "fleet") return base;
  if (key === "register") return `${base}/register`;
  return `${base}/${WORKSPACE_SEGMENT[key]}`;
}

export type ShellPath = {
  org: string | null;
  /** The workspace slug when the path is inside a workspace. */
  ws: string | null;
  /** Segments after the organization (org pages) or after the workspace (workspace pages). */
  rest: string[];
};

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split an app pathname into organization, workspace and the rest. */
export function parseShellPath(pathname: string): ShellPath {
  const path = pathname.replace(/[?#].*$/, "");
  const segments = path.split("/").filter(Boolean).map(safeDecode);
  const [org, first, ...rest] = segments;
  if (org === undefined) return { org: null, ws: null, rest: [] };
  if (first === undefined) return { org, ws: null, rest: [] };
  if (orgSegmentKey(first) !== null)
    return { org, ws: null, rest: [first, ...rest] };
  return { org, ws: first, rest };
}

/** The nav item a pathname belongs to, or null for a path outside the ten pages. */
export function currentNavKey(pathname: string): NavKey | null {
  const { org, ws, rest } = parseShellPath(pathname);
  if (org === null) return null;
  const [head] = rest;
  if (ws === null) {
    if (head === undefined) return "organization";
    return orgSegmentKey(head);
  }
  if (head === undefined || head === "runs") return "fleet";
  if (head === "register") return "register";
  const found = (
    Object.entries(WORKSPACE_SEGMENT) as [WorkspaceNavKey, string][]
  ).find(([, segment]) => segment === head);
  return found ? found[0] : null;
}

/** Whether a sidebar item is the current page. API keys and roles sit under Organization. */
export function isNavItemCurrent(key: NavKey, pathname: string): boolean {
  const current = currentNavKey(pathname);
  if (current === key) return true;
  return (
    key === "organization" && (current === "apiKeys" || current === "roles")
  );
}

export type NavItem = {
  key: NavKey;
  href: string;
  /** Null when the count is not recorded; the sidebar then shows no count, never a zero. */
  count: number | null;
  /** A count that needs attention (pending approvals, open incidents). */
  hot: boolean;
};

export type NavSection = {
  key: "workspace" | "organization";
  items: NavItem[];
};

/**
 * The sidebar's sections. `ws` is the workspace the workspace section points
 * at: the current one on a workspace page, the viewer's default on an
 * organization page, or null when the organization has none (the section is
 * then omitted).
 */
export function sidebarSections(
  org: string,
  ws: string | null,
  counts: NavCounts | null,
): NavSection[] {
  const sections: NavSection[] = [];
  if (ws !== null) {
    const countFor = (key: WorkspaceNavKey): Pick<NavItem, "count" | "hot"> => {
      if (counts === null) return { count: null, hot: false };
      if (key === "fleet") return { count: counts.pendingApprovals, hot: true };
      if (key === "agents") return { count: counts.agents, hot: false };
      if (key === "steering")
        return { count: counts.openProposals, hot: false };
      return { count: null, hot: false };
    };
    sections.push({
      key: "workspace",
      items: WORKSPACE_NAV.map((key) => ({
        key,
        href: workspaceHref(org, ws, key),
        ...countFor(key),
      })),
    });
  }
  sections.push({
    key: "organization",
    items: ORG_NAV.map((key) => ({
      key,
      href: orgHref(org, key),
      count: key === "audit" && counts !== null ? counts.openIncidents : null,
      hot: key === "audit",
    })),
  });
  return sections;
}

/** A count worth drawing: recorded and above zero. */
export function visibleCount(item: NavItem): number | null {
  return item.count !== null && item.count > 0 ? item.count : null;
}

export type Crumb =
  | { kind: "nav"; key: NavKey; href: string | null }
  | { kind: "name"; text: string; href: string | null }
  | { kind: "id"; text: string; href: string | null };

/** Breadcrumbs for a pathname, per the mockup's `crumbs()`. The last crumb has no href. */
export function breadcrumbs(
  pathname: string,
  names: { org: string; ws: string | null },
): Crumb[] {
  const { org, ws, rest } = parseShellPath(pathname);
  if (org === null) return [];
  const out: Crumb[] = [
    { kind: "name", text: names.org, href: `/${enc(org)}` },
  ];
  if (ws === null) {
    const key = currentNavKey(pathname);
    if (key === "apiKeys" || key === "roles") {
      out.push({ kind: "nav", key: "organization", href: `/${enc(org)}` });
      out.push({ kind: "nav", key, href: null });
    } else if (key !== null) {
      out.push({ kind: "nav", key, href: null });
    }
    return finish(out);
  }
  const base = `/${enc(org)}/${enc(ws)}`;
  out.push({ kind: "name", text: names.ws ?? ws, href: base });
  const [head, id, sub, subId] = rest;
  switch (head) {
    case undefined:
      out.push({ kind: "nav", key: "fleet", href: null });
      break;
    case "runs":
      out.push({ kind: "nav", key: "fleet", href: base });
      if (id !== undefined) out.push({ kind: "id", text: id, href: null });
      break;
    case "agents":
      out.push({ kind: "nav", key: "agents", href: `${base}/agents` });
      if (id !== undefined) {
        const agentHref = `${base}/agents/${enc(id)}`;
        out.push({ kind: "id", text: id, href: agentHref });
        if (sub === "source")
          out.push({ kind: "id", text: "source", href: null });
        if (sub === "mandates" && subId !== undefined)
          out.push({ kind: "id", text: subId, href: null });
      }
      break;
    case "register":
      out.push({ kind: "nav", key: "register", href: null });
      break;
    default: {
      const key = currentNavKey(pathname);
      if (key !== null) out.push({ kind: "nav", key, href: null });
    }
  }
  return finish(out);
}

function finish(crumbs: Crumb[]): Crumb[] {
  const last = crumbs.at(-1);
  if (last) crumbs[crumbs.length - 1] = { ...last, href: null };
  return crumbs;
}
