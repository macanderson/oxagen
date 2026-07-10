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
  /** Workspace picker — also the Org mode root. */
  root: (ctx: ScopeContext): string => `/${ctx.orgSlug}`,

  members: (ctx: ScopeContext): string => `/${ctx.orgSlug}/members`,

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

  // Billing — promoted from legacy settings/billing
  billing: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing`,
    subscription: (ctx: ScopeContext): string =>
      `/${ctx.orgSlug}/billing/subscription`,
    usage: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/usage`,
    invoices: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/invoices`,
  },

  // Developer portal (wired tabs only: mcp, tokens)
  developer: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer`,
    mcp: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/mcp`,
    tokens: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/tokens`,
  },

  // Org-level settings — editable by owners and admins only. No `plugins`
  // builder here: that route has no page behind it at org scope (plugins
  // management lives at workspace scope, Workbench → Agent Tools) — removed
  // after it was found dead (only consumer was the sidebar Marketplace
  // fallback, itself fixed to fall back to the org root instead).
  settings: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    general: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    privacy: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/privacy`,
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

  // Ask — the front door (full-page ask/chat surface).
  ask: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/ask`,

  // Workbench — build interactive agents. Four first-class pages, each a
  // sidebar destination: Agents (the builder), Agent Tools (the single home
  // for everything an agent can be equipped with — skills, MCP servers,
  // capabilities), Environments (env vars + secrets), and Sandboxes.
  workbench: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/workbench`,
    agents: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/agents`,
    agentNew: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/agents/new`,
    agent: (ctx: Required<ScopeContext>, agentId: string): string =>
      `${wsBase(ctx)}/workbench/agents/${encodeURIComponent(agentId)}`,
    // Environments — named env-var/secret sets agents run with. Promoted from
    // workspace settings to a first-class Workbench page.
    environments: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/environments`,
    // Sandboxes — durable code-agent sandboxes: warm one, drive a terminal,
    // inspect its files. The detail page is keyed by the sbx_* session id.
    sandboxes: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/sandboxes`,
    sandbox: (ctx: Required<ScopeContext>, sessionId: string): string =>
      `${wsBase(ctx)}/workbench/sandboxes/${encodeURIComponent(sessionId)}`,
    // Agent Tools hub — All Tools / Skills / MCP Servers / Capabilities.
    tools: {
      root: (ctx: Required<ScopeContext>): string =>
        `${wsBase(ctx)}/workbench/tools`,
      skills: (ctx: Required<ScopeContext>): string =>
        `${wsBase(ctx)}/workbench/tools/skills`,
      skill: (ctx: Required<ScopeContext>, skillSlug: string): string =>
        `${wsBase(ctx)}/workbench/tools/skills/${encodeURIComponent(skillSlug)}`,
      mcp: (ctx: Required<ScopeContext>): string =>
        `${wsBase(ctx)}/workbench/tools/mcp`,
      capabilities: (ctx: Required<ScopeContext>): string =>
        `${wsBase(ctx)}/workbench/tools/capabilities`,
    },
  },

  // Marketplace — discover + install, two sides: Agent Tools (skills, MCP
  // servers, capabilities) and Integrations (data connectors). Managing what
  // is already installed lives in Workbench → Agent Tools, not here.
  marketplace: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/marketplace`,
    agentTools: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/marketplace/agent-tools`,
    integrations: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/marketplace/integrations`,
    // Legacy tabs — browse became the Agent Tools side; installed/mcp moved
    // into Workbench → Agent Tools. Builders retarget so old callers keep working.
    browse: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/marketplace/agent-tools`,
    installed: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/tools/capabilities`,
    mcp: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/workbench/tools/mcp`,
  },

  // Activity — recent agent runs + per-run span-tree trace viewer.
  activity: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/activity`,
    // Per-run span tree. executionId is the aex_* public id.
    run: (ctx: Required<ScopeContext>, executionId: string): string =>
      `${wsBase(ctx)}/activity/${encodeURIComponent(executionId)}`,
  },

  // Knowledge
  knowledge: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/knowledge`,
    repos: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/repos`,
    inference: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/inference`,
    explore: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/explore`,
    memories: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/memories`,
    // Inspectable detail page for a single KnowledgeNode. Mirrors the
    // capability-meta RECORD_LINK_ROUTES["graph.node"] template so chat
    // deep-links and in-app navigation resolve to the same URL.
    node: (ctx: Required<ScopeContext>, nodeId: string): string =>
      `${wsBase(ctx)}/knowledge/nodes/${encodeURIComponent(nodeId)}`,
  },

  // Settings
  settings: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings`,
    general: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/general`,
    members: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/members`,
    models: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/models`,
    github: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/github`,
    prompts: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/prompts`,
    plugins: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/plugins`,
    skills: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/skills`,
    knowledge: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/knowledge`,
    memory: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/memory`,
    // MCP server registries — the catalog sources the marketplace and MCP
    // install flows discover servers from. Registry admin is a settings
    // concern; the servers themselves are managed in Workbench → Agent Tools.
    mcpServerRegistries: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/mcp-server-registries`,
    budget: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/budget`,
  },

  // Evals — score what actually ran and got billed (eval.* capability family).
  evals: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/evals`,
    run: (ctx: Required<ScopeContext>, runId: string): string =>
      `${wsBase(ctx)}/evals/runs/${encodeURIComponent(runId)}`,
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
  knowledge: "repos",
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
