export type TabConfig = {
  slug: string
  label: string
  badge?: number
  /** Filter chips rendered inside the tab (not nested tabs). Spec §5. */
  chips?: string[]
}

export type DestinationConfig = {
  id: string
  label: string
  /** "workspace" | "org" | "account" — used to build breadcrumb + base path. */
  scope: "workspace" | "org" | "account"
  tabs: TabConfig[]
  description: string
}

export const destinations: Record<string, DestinationConfig> = {
  // Workspace mode
  knowledge: {
    id: "knowledge",
    label: "Knowledge",
    scope: "workspace",
    description: "Sources, the ontology graph, and durable memories for this workspace.",
    tabs: [
      { slug: "sources", label: "Sources" },
      { slug: "graph", label: "Graph" },
      { slug: "memories", label: "Memories" },
    ],
  },
  automation: {
    id: "automation",
    label: "Automation",
    scope: "workspace",
    description: "Agents, playbooks, and the events and triggers that drive them.",
    tabs: [
      { slug: "agents", label: "Agents" },
      { slug: "playbooks", label: "Playbooks" },
      { slug: "events", label: "Events" },
      { slug: "triggers", label: "Triggers" },
    ],
  },
  activity: {
    id: "activity",
    label: "Activity",
    scope: "workspace",
    description: "Runs, approvals awaiting sign-off, and the workspace audit log.",
    tabs: [
      { slug: "runs", label: "Runs" },
      { slug: "approvals", label: "Approvals", badge: 3 },
      { slug: "audit", label: "Audit" },
    ],
  },
  studio: {
    id: "studio",
    label: "Studio",
    scope: "workspace",
    description: "Compose new generations and browse the workspace library.",
    tabs: [
      { slug: "compose", label: "Compose" },
      { slug: "library", label: "Library" },
    ],
  },
  settings: {
    id: "settings",
    label: "Settings",
    scope: "workspace",
    description: "Workspace configuration, members, keys, brand kits, and integrations.",
    tabs: [
      { slug: "general", label: "General" },
      { slug: "members", label: "Members" },
      { slug: "model-keys", label: "Model Keys" },
      { slug: "brand-kits", label: "Brand Kits" },
      { slug: "integrations", label: "Integrations" },
    ],
  },

  // Org mode
  members: {
    id: "members",
    label: "Members",
    scope: "org",
    description: "People in this organization, pending requests, and invitations.",
    tabs: [
      { slug: "people", label: "People" },
      { slug: "pending", label: "Pending", badge: 2 },
      { slug: "invitations", label: "Invitations" },
    ],
  },
  access: {
    id: "access",
    label: "Access",
    scope: "org",
    description: "Grants, roles, policies, requests, sessions, and identities.",
    tabs: [
      { slug: "grants", label: "Grants" },
      { slug: "roles", label: "Roles" },
      { slug: "policies", label: "Policies" },
      { slug: "requests", label: "Requests", badge: 5 },
      { slug: "sessions", label: "Sessions" },
      {
        slug: "identities",
        label: "Identities",
        chips: ["Humans", "Agents", "Service"],
      },
    ],
  },
  security: {
    id: "security",
    label: "Security",
    scope: "org",
    description: "SSO, SCIM, MFA, audit, compliance, and incidents.",
    tabs: [
      { slug: "sso", label: "SSO" },
      { slug: "scim", label: "SCIM" },
      { slug: "mfa", label: "MFA" },
      { slug: "audit", label: "Audit" },
      { slug: "compliance", label: "Compliance" },
      { slug: "incidents", label: "Incidents" },
    ],
  },
  billing: {
    id: "billing",
    label: "Billing",
    scope: "org",
    description: "Subscription, usage, invoices, and plan management.",
    tabs: [
      { slug: "subscription", label: "Subscription" },
      { slug: "usage", label: "Usage" },
      { slug: "invoices", label: "Invoices" },
      { slug: "plans", label: "Plans" },
    ],
  },
  developer: {
    id: "developer",
    label: "Developer",
    scope: "org",
    description: "MCP servers, webhooks, docs, and access tokens.",
    tabs: [
      { slug: "mcp", label: "MCP" },
      { slug: "webhooks", label: "Webhooks" },
      { slug: "docs", label: "Docs" },
      { slug: "tokens", label: "Tokens" },
    ],
  },
}

export function getDestination(id: string): DestinationConfig | undefined {
  return destinations[id]
}
