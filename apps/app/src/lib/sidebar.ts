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
  ArrowLeft,
  BookOpen,
  Bot,
  Box,
  Building2,
  CreditCard,
  FlaskConical,
  Gauge,
  GitBranch,
  KeyRound,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  Lock,
  MessageSquare,
  Scale,
  Settings,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Terminal,
  User,
  Users,
  Wrench,
  Zap,
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
// Groups:  primary (ask, knowledge)
//          footer  (marketplace, settings — pinned to bottom)
// ---------------------------------------------------------------------------

const workspaceConfig: SidebarConfig = {
  mode: "workspace",
  groupLabel: "Workspace",
  toolsLabel: "Workbench",
  items: [
    {
      id: "overview",
      label: "Overview",
      icon: Gauge,
      // Metering-forward workspace home (web-app-2.0): the HUD at the workspace
      // root (`/{org}/{ws}`) — spend/tokens/runs, knowledge-graph grounding,
      // activity, automations, memory, and source health. Now the FIRST tab and
      // the default workspace landing; Sessions (the chat front door) is second.
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: MessageSquare,
      // Sessions — the conversational front door (chat sessions). Uses the
      // workspace route; falls back gracefully when workspaceSlug is absent
      // (should not happen in workspace mode).
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.sessions(ctx as Required<ScopeContext>)
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
      id: "automations",
      label: "Automations",
      icon: Zap,
      // The biggest previously-headless section (automation.* + workflow.*):
      // human-gated agent automation, triggers, and parallel workflow/swarm runs.
      // Placed high (front-and-center) per the IA recommendation.
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.automations.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
    },
    // Workbench group — everything about building with agents. All four are
    // first-class sidebar destinations (there is deliberately NO Workbench
    // secondary nav): Agents (the builder), Agent Tools (the equip hub with
    // its own All Tools / Skills / MCP Servers / Capabilities sections),
    // Environments (env vars + secrets), and Sandboxes (durable code
    // sandboxes + their templates).
    {
      id: "agents",
      label: "Agents",
      icon: Bot,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.workbench.agents(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "tools",
    },
    {
      id: "evals",
      label: "Evals",
      icon: FlaskConical,
      // Score what actually ran and got billed against a dataset — the
      // eval.* capability family's dataset list + run-detail surface.
      // Previously a true nav orphan (no sidebar entry, no in-page inbound
      // links) despite being fully built. group: "primary" surfaces it in the
      // desktop sidebar (group-filtered render, see sidebar.tsx); it is
      // declared here (after the "agents" entry, ahead of the tools-group
      // items below, in raw array order) so the mobile bottom bar's unfiltered
      // first-4 cut (MAX_BAR_ITEMS, mobile-bottom-bar.tsx) is unaffected —
      // Evals overflows into the mobile "More" sheet alongside Agent
      // Tools/Environments/Sandboxes/Marketplace/Settings rather than
      // displacing Agents from the visible bar.
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.evals.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
    },
    {
      id: "agent-tools",
      label: "Agent Tools",
      icon: Wrench,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.workbench.tools.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "tools",
    },
    {
      id: "environments",
      label: "Environments",
      icon: Layers,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.workbench.environments(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "tools",
    },
    {
      id: "sandboxes",
      label: "Sandboxes",
      icon: Box,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.workbench.sandboxes(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "tools",
    },
    {
      id: "repos",
      label: "Repos",
      icon: GitBranch,
      // The whole headless repo.* family (sync, fork, create, edit→PR) gets a
      // home in the Workbench group (web-app-2.0).
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.workbench.repos(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "tools",
    },
    {
      id: "marketplace",
      label: "Marketplace",
      icon: ShoppingBag,
      // Discovery + install surface, two sides: Agent Tools and Integrations.
      // Managing what is installed lives in Workbench → Agent Tools.
      // No-workspaceSlug fallback mirrors every other workspace-mode item
      // above (org root) — it previously pointed at org.settings.plugins(),
      // an org-scope route helper with no page behind it (latent 404),
      // normally masked only because resolveSidebarCtx recovers the
      // workspace slug from the URL before this branch is reached.
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.marketplace.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
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
      id: "dashboard",
      label: "Dashboard",
      icon: LayoutDashboard,
      // Org home — the usage/metering dashboard (redirect target of the org
      // root `/{org}`). First item so it is the default org landing.
      href: (ctx) => org.dashboard(ctx),
      group: "primary",
    },
    {
      id: "workspaces",
      label: "Workspaces",
      icon: LayoutGrid,
      // Org-scope workspace picker (cards + avatars). Previously pointed at
      // org.root (`/{org}`), which immediately redirects into the first
      // workspace's Ask surface — clicking it from the governance surface
      // flashed an error before dumping the user on Ask. Now it lands on a
      // real listing page; each card is the jump into workspace mode.
      href: (ctx) => org.workspaces(ctx),
      group: "primary",
    },
    {
      id: "members",
      label: "Members",
      icon: Users,
      href: (ctx) => org.members(ctx),
      group: "primary",
    },
    {
      id: "governance",
      label: "Governance",
      icon: Scale,
      // The accountability-chain hub (web-app-2.0): the typed-contract catalog
      // (identity → scope → action → terms → outcome → audit) + IAM policies.
      href: (ctx) => org.governance.root(ctx),
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
      // Returns to the workspace Sessions surface when a workspace is known,
      // otherwise the org root or app root.
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.sessions(ctx as Required<ScopeContext>)
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
  "dashboard",
  "workspaces",
  "new-workspace",
  "members",
  "governance",
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
export function getSidebarConfig(
  mode: SidebarMode,
  planTier?: PlanTier,
): SidebarConfig {
  const isEnterprise = planTier === "enterprise";
  switch (mode) {
    case "workspace":
      return workspaceConfig;
    case "org": {
      return isEnterprise
        ? orgConfig
        : {
            ...orgConfig,
            items: orgConfig.items.filter((item) => item.id !== "access"),
          };
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
export function resolveSidebarMode(
  pathname: string,
  ctx: ScopeContext,
): SidebarMode {
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
export function resolveSidebarCtx(
  pathname: string,
  ctx: ScopeContext,
): ScopeContext {
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
export function activeHrefFor(
  pathname: string,
  hrefs: string[],
): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches =
      pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
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
 *   label  — display string (e.g. "Knowledge · Repos")
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
    targets.push({
      label: "Overview",
      href: workspace.root(wsCtx),
      parent: "overview",
    });
    targets.push({
      label: "Sessions",
      href: workspace.sessions(wsCtx),
      parent: "sessions",
    });
    targets.push({
      label: "Knowledge",
      href: workspace.knowledge.root(wsCtx),
      parent: "knowledge",
    });
    targets.push({
      label: "Automations",
      href: workspace.automations.root(wsCtx),
      parent: "automations",
    });
    targets.push({
      label: "Automations · Triggers",
      href: workspace.automations.triggers(wsCtx),
      parent: "automations",
    });
    targets.push({
      label: "Automations · Workflows",
      href: workspace.automations.workflows(wsCtx),
      parent: "automations",
    });
    targets.push({
      label: "Settings",
      href: workspace.settings.root(wsCtx),
      parent: "settings",
    });

    // Workbench destinations — all four are first-class sidebar items.
    targets.push({
      label: "Agents",
      href: workspace.workbench.agents(wsCtx),
      parent: "agents",
    });
    targets.push({
      label: "Agent Tools",
      href: workspace.workbench.tools.root(wsCtx),
      parent: "agent-tools",
    });
    targets.push({
      label: "Agent Tools · Skills",
      href: workspace.workbench.tools.skills(wsCtx),
      parent: "agent-tools",
    });
    targets.push({
      label: "Agent Tools · MCP Servers",
      href: workspace.workbench.tools.mcp(wsCtx),
      parent: "agent-tools",
    });
    targets.push({
      label: "Agent Tools · Capabilities",
      href: workspace.workbench.tools.capabilities(wsCtx),
      parent: "agent-tools",
    });
    targets.push({
      label: "Environments",
      href: workspace.workbench.environments(wsCtx),
      parent: "environments",
    });
    targets.push({
      label: "Sandboxes",
      href: workspace.workbench.sandboxes(wsCtx),
      parent: "sandboxes",
    });
    targets.push({
      label: "Repos",
      href: workspace.workbench.repos(wsCtx),
      parent: "repos",
    });

    // Knowledge tabs
    targets.push({
      label: "Knowledge · Sources",
      href: workspace.knowledge.sources(wsCtx),
      parent: "knowledge",
    });
    targets.push({
      label: "Knowledge · Graph",
      href: workspace.knowledge.graph(wsCtx),
      parent: "knowledge",
    });
    targets.push({
      label: "Knowledge · Inference",
      href: workspace.knowledge.inference(wsCtx),
      parent: "knowledge",
    });
    targets.push({
      label: "Knowledge · Ontology",
      href: workspace.knowledge.ontology(wsCtx),
      parent: "knowledge",
    });
    targets.push({
      label: "Knowledge · Memory",
      href: workspace.knowledge.memory(wsCtx),
      parent: "knowledge",
    });

    // Settings tabs
    targets.push({
      label: "Settings · General",
      href: workspace.settings.general(wsCtx),
      parent: "settings",
    });
    targets.push({
      label: "Settings · Agent Defaults",
      href: workspace.settings.agentDefaults(wsCtx),
      parent: "settings",
    });
    targets.push({
      label: "Settings · GitHub",
      href: workspace.settings.github(wsCtx),
      parent: "settings",
    });
    targets.push({
      label: "Settings · MCP Registries",
      href: workspace.settings.mcpServerRegistries(wsCtx),
      parent: "settings",
    });
  }

  // -- Org mode --
  targets.push({
    label: "Dashboard",
    href: org.dashboard(ctx),
    parent: "dashboard",
  });
  targets.push({
    label: "Workspaces",
    href: org.root(ctx),
    parent: "workspaces",
  });
  targets.push({ label: "Members", href: org.members(ctx), parent: "members" });
  targets.push({
    label: "Governance",
    href: org.governance.root(ctx),
    parent: "governance",
  });
  targets.push({
    label: "Governance · Capabilities",
    href: org.governance.capabilities(ctx),
    parent: "governance",
  });
  targets.push({
    label: "Governance · Policies",
    href: org.governance.policies(ctx),
    parent: "governance",
  });
  targets.push({
    label: "Access",
    href: org.access.root(ctx),
    parent: "access",
  });
  targets.push({
    label: "Security",
    href: org.security.root(ctx),
    parent: "security",
  });
  targets.push({
    label: "Billing",
    href: org.billing.root(ctx),
    parent: "billing",
  });
  targets.push({
    label: "Developer",
    href: org.developer.root(ctx),
    parent: "developer",
  });
  targets.push({
    label: "Settings · General",
    href: org.settings.general(ctx),
    parent: "org-settings",
  });

  // Access tabs (only wired tabs surfaced)
  targets.push({
    label: "Access · Sessions",
    href: org.access.sessions(ctx),
    parent: "access",
  });
  targets.push({
    label: "Access · Reviews",
    href: org.access.reviews(ctx),
    parent: "access",
  });

  // Security tabs (SSO + SCIM hidden from nav until their contracts ship)
  targets.push({
    label: "Security · MFA",
    href: org.security.mfa(ctx),
    parent: "security",
  });
  targets.push({
    label: "Security · Audit",
    href: org.security.audit(ctx),
    parent: "security",
  });
  targets.push({
    label: "Security · Compliance",
    href: org.security.compliance(ctx),
    parent: "security",
  });

  // Billing tabs
  targets.push({
    label: "Billing · Subscription",
    href: org.billing.subscription(ctx),
    parent: "billing",
  });
  targets.push({
    label: "Billing · Usage",
    href: org.billing.usage(ctx),
    parent: "billing",
  });
  targets.push({
    label: "Billing · Invoices",
    href: org.billing.invoices(ctx),
    parent: "billing",
  });

  // Developer tabs (wired tabs only)
  targets.push({
    label: "Developer · MCP",
    href: org.developer.mcp(ctx),
    parent: "developer",
  });
  targets.push({
    label: "Developer · Tokens",
    href: org.developer.tokens(ctx),
    parent: "developer",
  });

  // -- Account mode --
  targets.push({
    label: "Profile",
    href: account.profile(),
    parent: "profile",
  });
  targets.push({
    label: "Preferences",
    href: account.preferences(),
    parent: "preferences",
  });
  targets.push({
    label: "Security",
    href: account.security(),
    parent: "security",
  });
  targets.push({
    label: "Privacy",
    href: account.privacy(),
    parent: "privacy",
  });

  return targets;
}
