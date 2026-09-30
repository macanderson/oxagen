// The shell's navigation model (ARCHITECTURE.md §1.2): the sidebar's ten
// links in the mockup's order (Workspace: Fleet, Agents, Tools, Steering,
// Runtimes, Repositories, Spend; Organization: Organization, Billing, Audit),
// the phone's thumb bar and More
// sheet over the same keys, which item is current, and the breadcrumbs. Pure
// functions of the URL, so the sidebar, top bar, command menu and <MobileNav>
// agree on one model. Run has no entry: it opens from the Fleet runs table.
// Skills has none either: it is a tab of Steering (MC spec §10.7), and
// `/{org}/{ws}/skills` redirects there.

import { pathOf, type SafePath } from "@/shared/safe-path";

export type WorkspaceNavKey =
  | "fleet"
  | "agents"
  | "tools"
  | "steering"
  | "runtimes"
  | "repositories"
  | "spend";
export type OrgNavKey = "organization" | "billing" | "audit";
/** Roles, API keys, Model funding and Single sign-on are pages under Organization, not sidebar items of their own. */
type OrgPageNavKey = "apiKeys" | "roles" | "modelFunding" | "sso";
export type NavKey = WorkspaceNavKey | OrgNavKey | OrgPageNavKey;

export const WORKSPACE_NAV: readonly WorkspaceNavKey[] = [
  "fleet",
  "agents",
  "tools",
  "steering",
  "runtimes",
  "repositories",
  "spend",
];
export const ORG_NAV: readonly OrgNavKey[] = [
  "organization",
  "billing",
  "audit",
];
/**
 * The Organization pages that carry a nav label and a breadcrumb but no sidebar
 * item of their own. Named once because the current-item test and the
 * breadcrumb trail both spelled the pair out, so `roles` arriving beside
 * `apiKeys` had to be added in two places to be treated as one of them.
 */
const ORG_PAGE_NAV: Readonly<Record<OrgPageNavKey, true>> = {
  apiKeys: true,
  roles: true,
  modelFunding: true,
  sso: true,
};

/** Whether a nav key is one of the Organization pages without a sidebar item. */
function isOrgPageNavKey(key: NavKey | null): key is OrgPageNavKey {
  return key !== null && key in ORG_PAGE_NAV;
}

type ThumbSlot = Extract<
  WorkspaceNavKey,
  "fleet" | "agents" | "tools" | "spend"
>;

/** The phone's thumb bar: these four slots, then More (mockup `mobileNav`). */
export const THUMB_SLOTS: readonly ThumbSlot[] = [
  "fleet",
  "agents",
  "tools",
  "spend",
];

/** The rest of the sidebar, one tap away in the phone's More sheet (mockup `DLG_EXT.more`). */
export const MORE_SHEET: readonly NavKey[] = [
  "steering",
  "runtimes",
  "repositories",
  "organization",
  "billing",
  "audit",
];

/**
 * Static segments directly under `/{org}` (Batch 0 route tree). Any other first
 * segment is a workspace slug, which is why workspace slugs must not take these.
 */
const ORG_SEGMENTS = {
  billing: "billing",
  audit: "audit",
  "api-keys": "apiKeys",
  roles: "roles",
  "model-funding": "modelFunding",
  sso: "sso",
} as const satisfies Record<string, NavKey>;

/** The nav key for a static organization segment, or null when the segment is a workspace slug. */
function orgSegmentKey(segment: string): NavKey | null {
  return isOrgSegment(segment) ? ORG_SEGMENTS[segment] : null;
}

function isOrgSegment(segment: string): segment is keyof typeof ORG_SEGMENTS {
  return Object.hasOwn(ORG_SEGMENTS, segment);
}

const WORKSPACE_SEGMENT: Record<Exclude<WorkspaceNavKey, "fleet">, string> = {
  agents: "agents",
  tools: "tools",
  steering: "steering",
  runtimes: "runtimes",
  repositories: "repositories",
  spend: "spend",
};

export function orgHref(org: string, key: NavKey): SafePath {
  switch (key) {
    case "organization":
      return pathOf(org);
    case "billing":
      return pathOf(org, "billing");
    case "audit":
      return pathOf(org, "audit");
    case "apiKeys":
      return pathOf(org, "api-keys");
    case "roles":
      return pathOf(org, "roles");
    case "modelFunding":
      return pathOf(org, "model-funding");
    case "sso":
      return pathOf(org, "sso");
    default:
      throw new Error(`${key} is a workspace page, not an organization page`);
  }
}

export function workspaceHref(
  org: string,
  ws: string,
  key: WorkspaceNavKey,
): SafePath {
  if (key === "fleet") return pathOf(org, ws);
  return pathOf(org, ws, WORKSPACE_SEGMENT[key]);
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

/** The nav item a pathname belongs to, or null for a path no nav item holds. */
export function currentNavKey(pathname: string): NavKey | null {
  const { org, ws, rest } = parseShellPath(pathname);
  if (org === null) return null;
  const [head] = rest;
  if (ws === null) {
    if (head === undefined) return "organization";
    return orgSegmentKey(head);
  }
  if (head === undefined || head === "runs") return "fleet";
  // A mandate belongs to an agent and has no sidebar item of its own, so it
  // lights Agents the same way a run with no Runs item lights Fleet above.
  if (head === "mandates") return "agents";
  return (
    WORKSPACE_NAV.find(
      (key) => key !== "fleet" && WORKSPACE_SEGMENT[key] === head,
    ) ?? null
  );
}

/** Whether a sidebar item is the current page. Roles and API keys sit under Organization. */
export function isNavItemCurrent(key: NavKey, pathname: string): boolean {
  const current = currentNavKey(pathname);
  if (current === key) return true;
  return key === "organization" && isOrgPageNavKey(current);
}

/** Whether the current page is one the More sheet holds, so the More slot is current. */
export function isMoreCurrent(pathname: string): boolean {
  return MORE_SHEET.some((key) => isNavItemCurrent(key, pathname));
}

export type NavItem = {
  key: NavKey;
  href: SafePath;
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
export function sidebarSections(org: string, ws: string | null): NavSection[] {
  const sections: NavSection[] = [];
  if (ws !== null)
    sections.push({
      key: "workspace",
      items: WORKSPACE_NAV.map((key) => ({
        key,
        href: workspaceHref(org, ws, key),
      })),
    });
  sections.push({
    key: "organization",
    items: ORG_NAV.map((key) => ({ key, href: orgHref(org, key) })),
  });
  return sections;
}

export type Crumb =
  | { kind: "nav"; key: NavKey; href: SafePath | null }
  | { kind: "name"; text: string; href: SafePath | null }
  | { kind: "id"; text: string; href: SafePath | null };

/**
 * Breadcrumbs for a pathname, per the mockup's `crumbs()`. The last crumb has
 * no href. `record` is what the page declared it is showing (`PageRecord`),
 * so a route whose segment is a key can end on the record's name.
 */
export function breadcrumbs(
  pathname: string,
  names: {
    org: string;
    ws: string | null;
    record?: { id: string | null; label: string | null } | null;
  },
): Crumb[] {
  const { org, ws, rest } = parseShellPath(pathname);
  if (org === null) return [];
  const out: Crumb[] = [{ kind: "name", text: names.org, href: pathOf(org) }];
  if (ws === null) {
    const key = currentNavKey(pathname);
    if (isOrgPageNavKey(key)) {
      out.push({ kind: "nav", key: "organization", href: pathOf(org) });
      out.push({ kind: "nav", key, href: null });
    } else if (key !== null) {
      out.push({ kind: "nav", key, href: null });
    }
    return finish(out);
  }
  const base = pathOf(org, ws);
  out.push({ kind: "name", text: names.ws ?? ws, href: base });
  const [head, id, sub] = rest;
  switch (head) {
    case undefined:
      out.push({ kind: "nav", key: "fleet", href: null });
      break;
    case "runs":
      out.push({ kind: "nav", key: "fleet", href: base });
      if (id !== undefined) out.push({ kind: "id", text: id, href: null });
      break;
    case "agents":
      out.push({ kind: "nav", key: "agents", href: pathOf(org, ws, "agents") });
      if (id !== undefined) {
        const agentHref = pathOf(org, ws, "agents", id);
        out.push({ kind: "id", text: id, href: agentHref });
      }
      break;
    case "mandates":
      // Flat route (ARCHITECTURE.md §1.2): the mandate is not nested under
      // its agent, but Agents is still the nav item it lights, so the trail
      // ends at Agents → the mandate id, mirroring the runs → fleet case.
      out.push({ kind: "nav", key: "agents", href: pathOf(org, ws, "agents") });
      if (id !== undefined) out.push({ kind: "id", text: id, href: null });
      break;
    case "runtimes":
      // One runtime ends the trail on the runtime's name, under Runtimes
      // (mockup `crumbs()`: the list is a link, the name is mono). The
      // segment is the enrollment id, so the name is the one the page
      // declared for that id; until it has, the id stands in. The id stays
      // copyable on the page, in the rollback command.
      out.push({
        kind: "nav",
        key: "runtimes",
        href: pathOf(org, ws, "runtimes"),
      });
      if (id !== undefined) {
        const label = names.record?.id === id ? (names.record.label ?? id) : id;
        out.push({ kind: "id", text: label, href: null });
      }
      break;
    case "steering":
      // One record ends the trail on its label under Steering (ADR-178). The
      // segment is the lineage, so the label is the one the page declared for
      // that lineage. Until it has, the lineage stands in, in mono as an id.
      if (id === "records" && sub !== undefined) {
        out.push({
          kind: "nav",
          key: "steering",
          href: pathOf(org, ws, "steering"),
        });
        const label = names.record?.id === sub ? names.record.label : null;
        out.push(
          label === null
            ? { kind: "id", text: sub, href: null }
            : { kind: "name", text: label, href: null },
        );
      } else out.push({ kind: "nav", key: "steering", href: null });
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
