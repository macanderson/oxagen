/**
 * routes.ts — typed route builders for the full IA tree.
 *
 * Every URL in the application is produced by a function in this file.
 * No route string should be hard-coded elsewhere — callers import and
 * call these builders so that renames stay in one place.
 *
 * Segment constants live here so the sidebar, breadcrumbs, and command
 * menu can all reference them without duplicating magic strings.
 *
 * Reference: docs/architecture/information-architecture/spec.md §4, §7
 *             docs/architecture/application-shell/spec.md §5
 */

import type { ScopeContext } from "./scope";

// ---------------------------------------------------------------------------
// Account scope — /account/...
// ---------------------------------------------------------------------------

export const account = {
  root: (): string => "/account",
  profile: (): string => "/account/profile",
  preferences: (): string => "/account/preferences",
  security: (): string => "/account/security",
  privacy: (): string => "/account/privacy",
} as const;

// ---------------------------------------------------------------------------
// Org scope — /{org}/...
// ---------------------------------------------------------------------------

export const org = {
  /** Org root — redirects to the dashboard. */
  root: (ctx: ScopeContext): string => `/${ctx.orgSlug}`,

  /** Org dashboard — the usage/metering home (redirect target of the org root). */
  dashboard: (ctx: ScopeContext): string => `/${ctx.orgSlug}/dashboard`,

  /** Org workspaces listing — cards for every workspace in the org. */
  workspaces: (ctx: ScopeContext): string => `/${ctx.orgSlug}/workspaces`,

  members: (ctx: ScopeContext): string => `/${ctx.orgSlug}/members`,

  // Governance (web-app-2.0) — the accountability-chain hub. Renders each typed
  // capability contract as the one enforced object (identity → scope → action →
  // terms → outcome → audit); Policies covers IAM roles/entitlements + MCP auth.
  governance: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/governance`,
    capabilities: (ctx: ScopeContext): string =>
      `/${ctx.orgSlug}/governance/capabilities`,
    policies: (ctx: ScopeContext): string =>
      `/${ctx.orgSlug}/governance/policies`,
  },

  // Access sub-routes (only wired tabs remain: sessions, reviews)
  access: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access`,
    sessions: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/sessions`,
    reviews: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/reviews`,
  },

  // Security sub-routes
  security: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security`,
    mfa: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/mfa`,
    audit: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/audit`,
    compliance: (ctx: ScopeContext): string =>
      `/${ctx.orgSlug}/security/compliance`,
    trust: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/trust`,
  },

  // Billing
  billing: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing`,
    subscription: (ctx: ScopeContext): string =>
      `/${ctx.orgSlug}/billing/subscription`,
    usage: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/usage`,
    invoices: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/invoices`,
    revenue: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/revenue`,
  },

  // Developer portal (wired tabs only: mcp, tokens)
  developer: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer`,
    mcp: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/mcp`,
    tokens: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/tokens`,
  },

  // Org-level settings — editable by owners and admins only. There is
  // deliberately no `plugins` builder here: that route has no page behind it at
  // org scope; plugin management lives at workspace scope, under
  // Agents → Tools.
  settings: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    general: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    privacy: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/privacy`,
    // Who pays for the in-app assistant's tokens: the org's own model-vendor
    // key, or Oxagen's key under a monthly cap (ADR-053 §2–3).
    modelFunding: (ctx: ScopeContext): string =>
      `/${ctx.orgSlug}/settings/model-funding`,
  },
} as const;

// ---------------------------------------------------------------------------
// Workspace scope — /{org}/{ws}/...
// ---------------------------------------------------------------------------

/**
 * Workspace route builders require both orgSlug and workspaceSlug.
 * Callers must ensure workspaceSlug is defined before calling these.
 */
const wsBase = (ctx: Required<ScopeContext>): string =>
  `/${ctx.orgSlug}/${ctx.workspaceSlug}`;

export const workspace = {
  root: (ctx: Required<ScopeContext>): string => wsBase(ctx),

  // Sessions — the chat front door (full-page conversation-sessions surface).
  sessions: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/sessions`,

  // Agents — the governed agent registry and everything an agent is bound to.
  // Three first-class pages, each a sidebar destination: Agents (the registry +
  // builder), Tools (the allowlist surface: MCP servers + capabilities), and
  // Environments (env vars + secrets). The `workbench` path segment is retained
  // for now so existing links keep resolving.
  workbench: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/workbench`,
    agents: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/agents`,
    agentNew: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/agents/new`,
    agent: (ctx: Required<ScopeContext>, agentId: string): string =>
      `${wsBase(ctx)}/workbench/agents/${encodeURIComponent(agentId)}`,
    // Environments — named env-var/secret sets agents are bound to.
    environments: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/environments`,
    // Tools hub — All Tools / MCP Servers / Capabilities.
    tools: {
      root: (ctx: Required<ScopeContext>): string =>
        `${wsBase(ctx)}/workbench/tools`,
      mcp: (ctx: Required<ScopeContext>): string =>
        `${wsBase(ctx)}/workbench/tools/mcp`,
      capabilities: (ctx: Required<ScopeContext>): string =>
        `${wsBase(ctx)}/workbench/tools/capabilities`,
    },
  },

  // Marketplace — discover + install, two sides: Agent Tools (MCP servers +
  // capabilities) and Integrations (data connectors). Managing what is already
  // installed lives in Agents → Tools, not here.
  marketplace: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/marketplace`,
    agentTools: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/marketplace/agent-tools`,
    integrations: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/marketplace/integrations`,
    // Legacy tabs — browse became the Agent Tools side; installed/mcp moved
    // into Agents → Tools. Builders retarget so old callers keep working.
    browse: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/marketplace/agent-tools`,
    installed: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/tools/capabilities`,
    mcp: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/tools/mcp`,
  },

  // Knowledge — Sources · Graph · Ontology · Memory. The graph explorer,
  // node browser, and query console
  // all live under the single /knowledge/graph surface; node detail is a
  // child of Graph.
  knowledge: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/knowledge`,
    sources: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/sources`,
    sourcesConnect: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/sources/connect`,
    graph: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/graph`,
    ontology: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/ontology`,
    memory: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/memory`,
    // Citation analytics dashboard — which memories and graph nodes agents
    // actually cite, how useful those citations were, and where rules get
    // violated. Backed by agent.memory_citation.stats (get_citation_stats).
    citations: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/citations`,
    // Inspectable detail page for a single KnowledgeNode, now nested under
    // Graph. Mirrors capability-meta RECORD_LINK_ROUTES["graph.node"] so chat
    // deep-links and in-app navigation resolve to the same URL.
    node: (ctx: Required<ScopeContext>, nodeId: string): string =>
      `${wsBase(ctx)}/knowledge/graph/${encodeURIComponent(nodeId)}`,
  },

  // Settings — web-app-2.0 Phase 2 consolidation: General (with a Members
  // sub-tab) · Agent Defaults (Models·Budget·Prompts·Memory-policy sub-tabs) ·
  // GitHub · MCP Registries. The ontology/schema builder moved to Knowledge.
  settings: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings`,
    general: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/general`,
    // Members folded into General as a sub-tab (no standalone route).
    members: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/general?tab=members`,
    // Consolidated agent-behaviour defaults page.
    agentDefaults: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/agent-defaults`,
    github: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/github`,
    // MCP server registries — the catalog sources the marketplace and MCP
    // install flows discover servers from. Registry admin is a settings
    // concern; the servers themselves are managed in Workbench → Agent Tools.
    mcpServerRegistries: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/mcp-server-registries`,
    // Hard period-to-date spend ceilings (org + workspace scope) — powers
    // get_spend_budget / set_spend_budget. Workspace-scoped
    // (real workspaceId) so the RLS-narrowed read returns BOTH scopes; see
    // ./settings/spend-budgets/actions.ts for the placement rationale.
    spendBudgets: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/spend-budgets`,
    // Deprecated sub-tab aliases — the four agent-behaviour tabs merged into
    // Agent Defaults, and the ontology moved to Knowledge. Retained so existing
    // callers keep compiling and revalidate the correct destination; proxy.ts
    // 301-redirects the old URLs.
    models: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/agent-defaults`,
    budget: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/agent-defaults`,
    prompts: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/agent-defaults`,
    memory: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/agent-defaults`,
    knowledge: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/ontology`,
  },
} as const;

// ---------------------------------------------------------------------------
// Default tab map
//
// Per application-shell spec §5 rule 3: visiting a parent route redirects
// to its first tab. This map drives the redirect logic in each layout file.
//
// Key: the parent path segment (relative, no leading slash).
// Value: the first-tab segment to redirect to.
// ---------------------------------------------------------------------------

export const defaultTab: Record<string, string> = {
  // Workspace-scope parents
  knowledge: "sources",
  settings: "general",
  workbench: "agents",
  marketplace: "agent-tools",

  // Org-scope parents
  access: "sessions",
  security: "audit",
  billing: "subscription",
  developer: "mcp",

  // Org members has multiple tabs but no nested route — handled inline.
  members: "people",
};
