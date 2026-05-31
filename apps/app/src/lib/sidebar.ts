/**
 * sidebar.ts — the single source of truth for all three navigation modes.
 *
 * This file is pure data + functions. No JSX. No React. No server-only imports.
 * It can be imported in RSC, client components, and test files alike.
 *
 * Shape defined in: docs/architecture/application-shell/spec.md §14
 * IA content from:  docs/architecture/information-architecture/spec.md §4, §7
 */

import {
  MessageSquare,
  BookOpen,
  Zap,
  Activity,
  Wrench,
  Settings,
  Building2,
  Users,
  ShieldCheck,
  Shield,
  CreditCard,
  Code2,
  ChevronLeft,
  User,
  Bell,
  Lock,
  FileText,
  Eye,
  type LucideIcon,
} from "lucide-react";

import type { ScopeContext } from "./scope.js";
import { account, org, workspace } from "./routes.js";

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
  items: SidebarItem[];
};

// ---------------------------------------------------------------------------
// Workspace mode config — 6 items
// /{org}/{ws}/... — daily operational surface
//
// Groups:  primary (chat, knowledge, automation, activity)
//          tools   (studio — visually de-emphasised)
//          footer  (settings — pinned to bottom)
// ---------------------------------------------------------------------------

const workspaceConfig: SidebarConfig = {
  mode: "workspace",
  items: [
    {
      id: "chat",
      label: "Chat",
      icon: MessageSquare,
      // Chat is the front door. Uses workspace route; falls back gracefully
      // when workspaceSlug is absent (should not happen in workspace mode).
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.chat(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "primary",
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
      icon: Zap,
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
      id: "studio",
      label: "Studio",
      icon: Wrench,
      href: (ctx) =>
        ctx.workspaceSlug
          ? workspace.studio.root(ctx as Required<ScopeContext>)
          : `/${ctx.orgSlug}`,
      group: "tools",
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
  items: [
    {
      id: "workspaces",
      label: "Workspaces",
      icon: Building2,
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
      icon: ShieldCheck,
      href: (ctx) => org.access.root(ctx),
      group: "primary",
    },
    {
      id: "security",
      label: "Security",
      icon: Shield,
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
      icon: Code2,
      href: (ctx) => org.developer.root(ctx),
      group: "primary",
    },
  ],
};

// ---------------------------------------------------------------------------
// Account mode config — 5 items + return link = 6 total
// /account/... — personal / GDPR surface
// ---------------------------------------------------------------------------

const accountConfig: SidebarConfig = {
  mode: "account",
  items: [
    {
      id: "back-to-app",
      label: "Back to app",
      icon: ChevronLeft,
      // Returns to the org root. The shell can enhance this with
      // localStorage-persisted last-visited workspace slug in Phase 2.
      href: (ctx) => (ctx.workspaceSlug ? `/${ctx.orgSlug}/${ctx.workspaceSlug}` : `/${ctx.orgSlug}`),
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
      id: "account-security",
      label: "Security",
      icon: Lock,
      href: () => account.security(),
      group: "primary",
    },
    {
      id: "cases",
      label: "Cases",
      icon: FileText,
      href: () => account.cases(),
      group: "primary",
    },
    {
      id: "notifications",
      label: "Notifications",
      icon: Bell,
      href: () => account.notifications(),
      group: "primary",
    },
    {
      id: "privacy",
      label: "Privacy",
      icon: Eye,
      href: () => account.privacy(),
      group: "primary",
    },
  ],
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the sidebar config for the given mode.
 * The AppShell calls this after resolving the mode from the URL.
 */
export function getSidebarConfig(mode: SidebarMode): SidebarConfig {
  switch (mode) {
    case "workspace":
      return workspaceConfig;
    case "org":
      return orgConfig;
    case "account":
      return accountConfig;
  }
}

/**
 * Derives the navigation mode from the current pathname and scope context.
 *
 * Rules (application-shell spec §3):
 *   /account/...         → "account"
 *   /{org}/{ws}/...      → "workspace" (workspaceSlug present in ctx)
 *   /{org}/...           → "org"
 *
 * Pathname must be the raw Next.js `pathname` string (no query params).
 */
export function resolveSidebarMode(pathname: string, ctx: ScopeContext): SidebarMode {
  if (pathname.startsWith("/account")) {
    return "account";
  }
  if (ctx.workspaceSlug) {
    return "workspace";
  }
  return "org";
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
    targets.push({ label: "Chat", href: workspace.chat(wsCtx), parent: "chat" });
    targets.push({ label: "Knowledge", href: workspace.knowledge.root(wsCtx), parent: "knowledge" });
    targets.push({ label: "Automation", href: workspace.automation.root(wsCtx), parent: "automation" });
    targets.push({ label: "Activity", href: workspace.activity.root(wsCtx), parent: "activity" });
    targets.push({ label: "Studio", href: workspace.studio.root(wsCtx), parent: "studio" });
    targets.push({ label: "Settings", href: workspace.settings.root(wsCtx), parent: "settings" });

    // Knowledge tabs
    targets.push({ label: "Knowledge · Sources", href: workspace.knowledge.sources(wsCtx), parent: "knowledge" });
    targets.push({ label: "Knowledge · Graph", href: workspace.knowledge.graph(wsCtx), parent: "knowledge" });
    targets.push({ label: "Knowledge · Memories", href: workspace.knowledge.memories(wsCtx), parent: "knowledge" });

    // Automation tabs
    targets.push({ label: "Automation · Agents", href: workspace.automation.agents(wsCtx), parent: "automation" });
    targets.push({ label: "Automation · Playbooks", href: workspace.automation.playbooks(wsCtx), parent: "automation" });
    targets.push({ label: "Automation · Events", href: workspace.automation.events(wsCtx), parent: "automation" });
    targets.push({ label: "Automation · Triggers", href: workspace.automation.triggers(wsCtx), parent: "automation" });

    // Activity tabs
    targets.push({ label: "Activity · Runs", href: workspace.activity.runs(wsCtx), parent: "activity" });
    targets.push({ label: "Activity · Approvals", href: workspace.activity.approvals(wsCtx), parent: "activity" });
    targets.push({ label: "Activity · Audit", href: workspace.activity.audit(wsCtx), parent: "activity" });

    // Studio tabs
    targets.push({ label: "Studio · Compose", href: workspace.studio.compose(wsCtx), parent: "studio" });
    targets.push({ label: "Studio · Library", href: workspace.studio.library(wsCtx), parent: "studio" });

    // Settings tabs
    targets.push({ label: "Settings · General", href: workspace.settings.general(wsCtx), parent: "settings" });
    targets.push({ label: "Settings · Members", href: workspace.settings.members(wsCtx), parent: "settings" });
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

  // Access tabs
  targets.push({ label: "Access · Grants", href: org.access.grants(ctx), parent: "access" });
  targets.push({ label: "Access · Roles", href: org.access.roles(ctx), parent: "access" });
  targets.push({ label: "Access · Policies", href: org.access.policies(ctx), parent: "access" });
  targets.push({ label: "Access · Requests", href: org.access.requests(ctx), parent: "access" });
  targets.push({ label: "Access · Sessions", href: org.access.sessions(ctx), parent: "access" });
  targets.push({ label: "Access · Identities", href: org.access.identities(ctx), parent: "access" });

  // Security tabs
  targets.push({ label: "Security · SSO", href: org.security.sso(ctx), parent: "security" });
  targets.push({ label: "Security · SCIM", href: org.security.scim(ctx), parent: "security" });
  targets.push({ label: "Security · MFA", href: org.security.mfa(ctx), parent: "security" });
  targets.push({ label: "Security · Audit", href: org.security.audit(ctx), parent: "security" });
  targets.push({ label: "Security · Compliance", href: org.security.compliance(ctx), parent: "security" });
  targets.push({ label: "Security · Incidents", href: org.security.incidents(ctx), parent: "security" });

  // Billing tabs
  targets.push({ label: "Billing · Subscription", href: org.billing.subscription(ctx), parent: "billing" });
  targets.push({ label: "Billing · Usage", href: org.billing.usage(ctx), parent: "billing" });
  targets.push({ label: "Billing · Invoices", href: org.billing.invoices(ctx), parent: "billing" });
  targets.push({ label: "Billing · Plans", href: org.billing.plans(ctx), parent: "billing" });

  // Developer tabs
  targets.push({ label: "Developer · MCP", href: org.developer.mcp(ctx), parent: "developer" });
  targets.push({ label: "Developer · Webhooks", href: org.developer.webhooks(ctx), parent: "developer" });
  targets.push({ label: "Developer · Docs", href: org.developer.docs(ctx), parent: "developer" });
  targets.push({ label: "Developer · Tokens", href: org.developer.tokens(ctx), parent: "developer" });

  // -- Account mode --
  targets.push({ label: "Profile", href: account.profile(), parent: "profile" });
  targets.push({ label: "Account Security", href: account.security(), parent: "account-security" });
  targets.push({ label: "Cases", href: account.cases(), parent: "cases" });
  targets.push({ label: "Notifications", href: account.notifications(), parent: "notifications" });
  targets.push({ label: "Privacy", href: account.privacy(), parent: "privacy" });

  return targets;
}
