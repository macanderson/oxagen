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

  // Org-level settings — editable by owners and admins only.
  settings: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    general: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    plugins: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/plugins`,
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

  // Knowledge
  knowledge: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/knowledge`,
    sources: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/sources`,
    graph: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/knowledge/graph`,
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
    environments: (ctx: Required<ScopeContext>): string =>
      `${wsBase(ctx)}/settings/environments`,
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

  // Org-scope parents
  access: "sessions",
  security: "audit",
  billing: "subscription",
  developer: "mcp",

  // Org members has multiple tabs but no nested route — handled inline.
  members: "people",
};
