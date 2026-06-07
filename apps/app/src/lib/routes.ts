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
} as const;

// ---------------------------------------------------------------------------
// Org scope — /{org}/...
// ---------------------------------------------------------------------------

export const org = {
  /** Workspace picker — also the Org mode root. */
  root: (ctx: ScopeContext): string => `/${ctx.orgSlug}`,

  members: (ctx: ScopeContext): string => `/${ctx.orgSlug}/members`,

  // Access sub-routes
  access: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access`,
    grants: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/grants`,
    roles: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/roles`,
    policies: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/policies`,
    requests: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/requests`,
    sessions: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/sessions`,
    identities: (ctx: ScopeContext): string => `/${ctx.orgSlug}/access/identities`,
  },

  // Security sub-routes
  security: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security`,
    sso: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/sso`,
    scim: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/scim`,
    mfa: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/mfa`,
    audit: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/audit`,
    compliance: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/compliance`,
    incidents: (ctx: ScopeContext): string => `/${ctx.orgSlug}/security/incidents`,
  },

  // Billing — promoted from legacy settings/billing
  billing: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing`,
    subscription: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/subscription`,
    usage: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/usage`,
    invoices: (ctx: ScopeContext): string => `/${ctx.orgSlug}/billing/invoices`,
  },

  // Developer portal
  developer: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer`,
    mcp: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/mcp`,
    webhooks: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/webhooks`,
    docs: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/docs`,
    tokens: (ctx: ScopeContext): string => `/${ctx.orgSlug}/developer/tokens`,
  },

  // Org-level settings — editable by owners and admins only.
  settings: {
    root: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    general: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/general`,
    plugins: (ctx: ScopeContext): string => `/${ctx.orgSlug}/settings/plugins`,
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
    sources: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/knowledge/sources`,
    graph: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/knowledge/graph`,
    memories: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/knowledge/memories`,
  },

  // Automation
  automation: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/automation`,
    agents: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/automation/agents`,
    playbooks: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/automation/playbooks`,
    events: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/automation/events`,
    triggers: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/automation/triggers`,
  },

  // Activity
  activity: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/activity`,
    runs: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/activity/runs`,
    approvals: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/activity/approvals`,
    audit: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/activity/audit`,
  },

  // Studio — de-emphasized Tools group
  studio: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/tools/studio`,
    compose: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/tools/studio/compose`,
    library: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/tools/studio/library`,
  },

  // Settings
  settings: {
    root: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings`,
    general: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings/general`,
    members: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings/members`,
    models: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings/models`,
    modelKeys: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings/model-keys`,
    brandKits: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings/brand-kits`,
    integrations: (ctx: Required<ScopeContext>): string => `${wsBase(ctx)}/settings/integrations`,
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
  automation: "agents",
  activity: "runs",
  studio: "compose",
  settings: "general",

  // Org-scope parents
  access: "grants",
  security: "audit",
  billing: "subscription",
  developer: "mcp",

  // Org members has multiple tabs but no nested route — handled inline.
  members: "people",
};
