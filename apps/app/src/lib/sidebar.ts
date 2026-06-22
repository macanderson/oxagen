/**
 * sidebar.ts — the single source of truth for all three navigation modes.
 *
 * This file is pure data + functions. No JSX. No React. No server-only imports.
 * It can be imported in RSC, client components, and test files alike.
 *
 * Shape defined in: docs/architecture/application-shell/spec.md §14
 * IA content from:  docs/architecture/information-architecture/spec.md §4, §7
 */

import type { PlanTier } from "@oxagen/oxagen/types";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Building2,
  CreditCard,
  KeyRound,
  LayoutGrid,
  Lock,
  MessageSquare,
  Settings,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Terminal,
  User,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import type { ScopeContext } from "./scope";
import { account, org, workspace } from "./routes";

// ---------------------------------------------------------------------------
// Core types (verbatim from application-shell spec §14)
// ---------------------------------------------------------------------------

export type SidebarMode = "workspace" | "org" | "account";

export type SidebarItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Computes the full href for this item given the current scope. */
  href: (ctx: ScopeContext) => string;
  /** Visual grouping within the sidebar column. */
  group?: "primary" | "tools" | "footer";
  /** Optional live count badge — return null to hide. */
  badge?: (ctx: ScopeContext) => number | null;
  /** Shows ↗ affordance — for items that jump to a different mode. */
  external?: boolean;
  /** Shows ↩ affordance — for "Back to app" / "Back to workspace" items. */
  isReturn?: boolean;
};

export type SidebarConfig = {
  mode: SidebarMode;
  /** Uppercase label shown above the primary group (e.g. "WORKSPACE"). */
  groupLabel?: string;
  /** Uppercase label shown above the tools group (e.g. "TOOLS"). */
  toolsLabel?: string;
  items: SidebarItem[];
};

// ---------------------------------------------------------------------------
// Workspace mode config — IA spec §4 tree.
// /{org}/{ws}/... — daily operational surface
//
// Groups:  primary (ask, knowledge, automation, activity)
//          tools   (studio, marketplace — visually de-emphasised)
//          footer  (settings — pinned to bottom)
//
// Agents live under Automation (a tab), all run kinds live under Activity →
// Runs, and "Workflows" is gone (folded into Activity → Runs; the word is a
// banned term per spec §19). No standalone Agents / Subagent Runs / Workflows
// sidebar entries.
// ---------------------------------------------------------------------------

const workspaceConfig: SidebarConfig = {
  mode: "workspace",
  groupLabel: "Workspace",
  items: [
    {
      id: "ask",
      label: "Ask",
      icon: MessageSquare,
      // Ask is the front door. Uses workspace route; falls back gracefully
      // when workspaceSlug is absent (should not happen in workspace mode).
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.ask(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
      external: true,
    },
    {
      id: "knowledge",
      label: "Knowledge",
      icon: BookOpen,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.knowledge.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
    },
    {
      id: "automation",
      label: "Automation",
      icon: Workflow,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.automation.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
    },
    {
      id: "activity",
      label: "Activity",
      icon: Activity,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.activity.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
    },
    {
      id: "marketplace",
      label: "Marketplace",
      icon: ShoppingBag,
      // The plugin marketplace now lives at the workspace settings → plugins route.
      // When workspaceSlug is available we link to the workspace-scoped page;
      // otherwise fall back to the org root (shouldn't happen in ws-mode).
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.settings.plugins(ctx as Required<ScopeContext>)
          : org.settings.plugins(ctx),
      group: "footer",
    },
    {
      id: "settings",
      label: "Settings",
      icon: Settings,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.settings.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "footer",
    },
  ],
};

// ---------------------------------------------------------------------------
// Org mode config — 6 items
// /{org}/... — governance surface
//
// "Workspaces" at the top is the path back to workspace mode (external: true).
// ---------------------------------------------------------------------------

const orgConfig: SidebarConfig = {
  mode: "org",
  groupLabel: "Organization",
  items: [
    {
      id: "workspaces",
      label: "Workspaces",
      icon: LayoutGrid,
      href: (ctx) => org.root(ctx),
      group: "primary",
      // external = true renders the ↗ affordance to signal mode transition.
      external: true,
    },
    {
      id: "members",
      label: "Members",
      icon: Users,
      href: (ctx) => org.members(ctx),
      group: "primary",
    },
    {
      id: "access",
      label: "Access",
      icon: KeyRound,
      href: (ctx) => org.access.root(ctx),
      group: "primary",
    },
    {
      id: "security",
      label: "Security",
      icon: ShieldCheck,
      href: (ctx) => org.security.root(ctx),
      group: "primary",
    },
    {
      id: "billing",
      label: "Billing",
      icon: CreditCard,
      href: (ctx) => org.billing.root(ctx),
      group: "primary",
    },
    {
      id: "developer",
      label: "Developer",
      icon: Terminal,
      href: (ctx) => org.developer.root(ctx),
      group: "primary",
    },
    {
      id: "org-settings",
      label: "Settings",
      icon: Building2,
      href: (ctx) => org.settings.general(ctx),
      group: "footer",
    },
  ],
};

// ---------------------------------------------------------------------------
// Account mode config — 6 items + return link = 7 total
// /account/... — personal / GDPR surface
// ---------------------------------------------------------------------------

const accountConfig: SidebarConfig = {
  mode: "account",
  groupLabel: "Account",
  items: [
    {
      id: "back",
      label: "Back to app",
      icon: ArrowLeft,
      // Returns to the workspace Ask surface when a workspace is known,
      // otherwise the org root or app root.
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.ask(ctx as Required<ScopeContext>)
          : ctx.orgSlug
            ? `/${ctx.orgSlug}`
            : "/",
      group: "primary",
      isReturn: true,
    },
    {
      id: "profile",
      label: "Profile",
      icon: User,
      href: () => account.profile(),
      group: "primary",
    },
    {
      id: "preferences",
      label: "Preferences",
      icon: SlidersHorizontal,
      href: () => account.preferences(),
      group: "primary",
    },
    {
      id: "security",
      label: "Security",
      icon: Lock,
      href: () => account.security(),
      group: "primary",
    },
    {
      id: "privacy",
      label: "Privacy",
      icon: ShieldCheck,
      href: () => account.privacy(),
      group: "primary",
    },
  ],
};

// ---------------------------------------------------------------------------
// Reserved org-scope route segments
//
// When the second URL segment matches one of these names it is an org-level
// page, NOT a workspace slug. This list must stay in sync with the route
// tree under apps/app/src/app/[orgSlug]/.
// ---------------------------------------------------------------------------

export const ORG_SCOPE_ROUTES = new Set([
  "members",
  "access",
  "security",
  "billing",
  "developer",
  "settings",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the sidebar config for the given mode.
 * Filters enterprise-only items (e.g. "access") for non-enterprise orgs.
 */
export function getSidebarConfig(mode: SidebarMode, planTier?: PlanTier): SidebarConfig {
  const isEnterprise = planTier === "enterprise";
  switch (mode) {
    case "workspace":
      return workspaceConfig;
    case "org": {
      return isEnterprise
        ? orgConfig
        : { ...orgConfig, items: orgConfig.items.filter((item) => item.id !== "access") };
    }
    case "account":
      return accountConfig;
  }
}

/**
 * Derives the navigation mode from the current pathname and scope context.
 *
 * Rules (application-shell spec §3):
 *   /account/...         → "account"
 *   /{org}/{ws}/...      → "workspace"
 *       where the 2nd segment is NOT a reserved org-scope route
 *   /{org}/...           → "org"
 *
 * The ctx.workspaceSlug fast-path is honoured when present, but the
 * AppShell at the org-layout boundary never sets workspaceSlug (it has no
 * access to the workspace param at that layout level). The pathname
 * derivation is therefore the canonical path for workspace detection.
 *
 * Pathname must be the raw Next.js `pathname` string (no query params).
 */
export function resolveSidebarMode(pathname: string, ctx: ScopeContext): SidebarMode {
  if (pathname.startsWith("/account")) {
    return "account";
  }
  // Fast-path: ctx already carries a workspaceSlug (e.g. injected by a
  // workspace-level layout that has access to the param).
  if (ctx.workspaceSlug) {
    return "workspace";
  }
  // Derive from URL shape: /{org}/{segment}/... where segment is not a
  // reserved org-scope route → workspace mode.
  const parts = pathname.split("/").filter(Boolean);
  // parts[0] = orgSlug, parts[1] = second segment (workspace slug or reserved route)
  if (parts.length >= 2 && !ORG_SCOPE_ROUTES.has(parts[1] as string)) {
    return "workspace";
  }
  return "org";
}

/**
 * Recover the effective scope context for sidebar href resolution.
 *
 * The org-level layout (`/[orgSlug]/layout.tsx`) mounts the shell WITHOUT a
 * workspaceSlug — it has no access to that route param. In workspace mode every
 * workspace item's `href()` would then hit its `ctx.workspaceSlug ? … : /{org}`
 * fallback and collapse to the org root, so all items share one href and the
 * prefix active-check lights up every row (and every link points at the org
 * root). We recover the workspace slug from the URL (the 2nd path segment) so
 * hrefs resolve to real workspace routes. Returns ctx unchanged when it already
 * has a workspaceSlug or the mode is not workspace.
 */
export function resolveSidebarCtx(pathname: string, ctx: ScopeContext): ScopeContext {
  if (ctx.workspaceSlug) return ctx;
  if (resolveSidebarMode(pathname, ctx) !== "workspace") return ctx;
  const workspaceSlug = pathname.split("/").filter(Boolean)[1];
  return workspaceSlug ? { ...ctx, workspaceSlug } : ctx;
}

/**
 * Pick the active item href for a pathname: the MOST SPECIFIC (longest) item
 * href that the pathname matches exactly or by path-segment prefix. Selecting
 * the longest match prevents an ancestor item (e.g. the org root "Workspaces"
 * at `/{org}`) from staying highlighted on every descendant page (`/{org}/...`)
 * — only the deepest matching item is active. Returns null when nothing matches.
 */
export function activeHrefFor(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches = pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
    if (matches && (best === null || href.length > best.length)) {
      best = href;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Nav target enumeration — used by the Phase-2 command menu
// ---------------------------------------------------------------------------

/**
 * Flattens all sidebar items across all three modes AND every tab from
 * routes.ts into a single searchable list.
 *
 * Each entry has:
 *   label  — display string (e.g. "Knowledge · Sources")
 *   href   — resolved path for the given ctx
 *   parent — the parent sidebar item id when applicable
 *
 * Used by the Ask bar / command menu to handle "Navigate" intents.
 */
export function enumerateNavTargets(
  ctx: ScopeContext,
): { label: string; href: string; parent?: string }[] {
  const targets: { label: string; href: string; parent?: string }[] = [];

  // -- Workspace mode --
  if (ctx.workspaceSlug) {
    const wsCtx = ctx as Required<ScopeContext>;

    // Sidebar-level items
    targets.push({ label: "Ask", href: workspace.ask(wsCtx), parent: "ask" });
    targets.push({ label: "Explore", href: workspace.explore(wsCtx), parent: "ask" });
    targets.push({ label: "Knowledge", href: workspace.knowledge.root(wsCtx), parent: "knowledge" });
    targets.push({ label: "Automation", href: workspace.automation.root(wsCtx), parent: "automation" });
    targets.push({ label: "Activity", href: workspace.activity.root(wsCtx), parent: "activity" });
    targets.push({ label: "Settings", href: workspace.settings.root(wsCtx), parent: "settings" });

    // Knowledge tabs
    targets.push({ label: "Knowledge · Sources", href: workspace.knowledge.sources(wsCtx), parent: "knowledge" });
    targets.push({ label: "Knowledge · Graph", href: workspace.knowledge.graph(wsCtx), parent: "knowledge" });
    targets.push({ label: "Knowledge · Memories", href: workspace.knowledge.memories(wsCtx), parent: "knowledge" });

    // Automation tabs
    targets.push({ label: "Automation · Agents", href: workspace.automation.agents(wsCtx), parent: "automation" });
    targets.push({ label: "Automation · Agents · New", href: workspace.agents.create(wsCtx), parent: "automation" });
    targets.push({ label: "Automation · Playbooks", href: workspace.automation.playbooks(wsCtx), parent: "automation" });
    targets.push({ label: "Automation · Event Sources", href: workspace.automation.eventSources(wsCtx), parent: "automation" });
    targets.push({ label: "Automation · Triggers", href: workspace.automation.triggers(wsCtx), parent: "automation" });

    // Activity tabs
    targets.push({ label: "Activity · Runs", href: workspace.activity.runs(wsCtx), parent: "activity" });
    targets.push({ label: "Activity · Approvals", href: workspace.activity.approvals(wsCtx), parent: "activity" });
    targets.push({ label: "Activity · Audit", href: workspace.activity.audit(wsCtx), parent: "activity" });

    // Settings tabs
    targets.push({ label: "Settings · General", href: workspace.settings.general(wsCtx), parent: "settings" });
    targets.push({ label: "Settings · Members", href: workspace.settings.members(wsCtx), parent: "settings" });
    targets.push({ label: "Settings · Models", href: workspace.settings.models(wsCtx), parent: "settings" });
    targets.push({ label: "Settings · Model Keys", href: workspace.settings.modelKeys(wsCtx), parent: "settings" });
    targets.push({ label: "Settings · Brand Kits", href: workspace.settings.brandKits(wsCtx), parent: "settings" });
    targets.push({ label: "Settings · Integrations", href: workspace.settings.integrations(wsCtx), parent: "settings" });
  }

  // -- Org mode --
  targets.push({ label: "Workspaces", href: org.root(ctx), parent: "workspaces" });
  targets.push({ label: "Members", href: org.members(ctx), parent: "members" });
  targets.push({ label: "Access", href: org.access.root(ctx), parent: "access" });
  targets.push({ label: "Security", href: org.security.root(ctx), parent: "security" });
  targets.push({ label: "Billing", href: org.billing.root(ctx), parent: "billing" });
  targets.push({ label: "Developer", href: org.developer.root(ctx), parent: "developer" });
  targets.push({ label: "Settings · General", href: org.settings.general(ctx), parent: "org-settings" });

  // Access tabs
  targets.push({ label: "Access · Grants", href: org.access.grants(ctx), parent: "access" });
  targets.push({ label: "Access · Roles", href: org.access.roles(ctx), parent: "access" });
  targets.push({ label: "Access · Policies", href: org.access.policies(ctx), parent: "access" });
  targets.push({ label: "Access · Requests", href: org.access.requests(ctx), parent: "access" });
  targets.push({ label: "Access · Sessions", href: org.access.sessions(ctx), parent: "access" });
  targets.push({ label: "Access · Principals", href: org.access.principals(ctx), parent: "access" });

  // Security tabs (SSO + SCIM hidden from nav until their contracts ship)
  targets.push({ label: "Security · MFA", href: org.security.mfa(ctx), parent: "security" });
  targets.push({ label: "Security · Audit", href: org.security.audit(ctx), parent: "security" });
  targets.push({ label: "Security · Compliance", href: org.security.compliance(ctx), parent: "security" });
  targets.push({ label: "Security · Incidents", href: org.security.incidents(ctx), parent: "security" });

  // Billing tabs
  targets.push({ label: "Billing · Subscription", href: org.billing.subscription(ctx), parent: "billing" });
  targets.push({ label: "Billing · Usage", href: org.billing.usage(ctx), parent: "billing" });
  targets.push({ label: "Billing · Invoices", href: org.billing.invoices(ctx), parent: "billing" });

  // Developer tabs
  targets.push({ label: "Developer · MCP", href: org.developer.mcp(ctx), parent: "developer" });
  targets.push({ label: "Developer · Webhooks", href: org.developer.webhooks(ctx), parent: "developer" });
  targets.push({ label: "Developer · Docs", href: org.developer.docs(ctx), parent: "developer" });
  targets.push({ label: "Developer · Tokens", href: org.developer.tokens(ctx), parent: "developer" });

  // -- Account mode --
  targets.push({ label: "Profile", href: account.profile(), parent: "profile" });
  targets.push({ label: "Preferences", href: account.preferences(), parent: "preferences" });
  targets.push({ label: "Security", href: account.security(), parent: "security" });
  targets.push({ label: "Privacy", href: account.privacy(), parent: "privacy" });

  return targets;
}
