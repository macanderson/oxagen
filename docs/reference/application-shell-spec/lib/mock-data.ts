export type Workspace = {
  slug: string
  name: string
  description: string
}

export type Org = {
  slug: string
  name: string
  plan: string
  workspaces: Workspace[]
}

export const orgs: Org[] = [
  {
    slug: "acme",
    name: "Acme Inc",
    plan: "Enterprise",
    workspaces: [
      { slug: "production", name: "Production", description: "Live customer-facing agents" },
      { slug: "staging", name: "Staging", description: "Pre-release validation" },
      { slug: "research", name: "Research", description: "Experimental playbooks" },
    ],
  },
  {
    slug: "globex",
    name: "Globex",
    plan: "Team",
    workspaces: [
      { slug: "core", name: "Core", description: "Primary workspace" },
      { slug: "labs", name: "Labs", description: "Internal tooling" },
    ],
  },
  {
    slug: "initech",
    name: "Initech",
    plan: "Pro",
    workspaces: [{ slug: "main", name: "Main", description: "Default workspace" }],
  },
]

export function getOrg(slug: string): Org | undefined {
  return orgs.find((o) => o.slug === slug)
}

export function getWorkspace(orgSlug: string, wsSlug: string): Workspace | undefined {
  return getOrg(orgSlug)?.workspaces.find((w) => w.slug === wsSlug)
}

export const defaultOrg = orgs[0]
export const defaultWorkspace = orgs[0].workspaces[0]

export const currentUser = {
  name: "Alex Rivera",
  email: "alex@acme.com",
  initials: "AR",
}

export type NotificationKind = "approval" | "run" | "member" | "security" | "system"

export type Notification = {
  id: string
  title: string
  body: string
  time: string
  unread: boolean
  archived: boolean
  kind: NotificationKind
}

export const notifications: Notification[] = [
  {
    id: "n1",
    title: "Approval requested",
    body: "Playbook “churn-investigate” needs your sign-off before it can run.",
    time: "2m ago",
    unread: true,
    archived: false,
    kind: "approval",
  },
  {
    id: "n2",
    title: "Run completed",
    body: "Run #4221 finished successfully in 1m 12s.",
    time: "18m ago",
    unread: true,
    archived: false,
    kind: "run",
  },
  {
    id: "n3",
    title: "New member joined",
    body: "jordan@acme.com accepted their invitation to Acme Inc.",
    time: "1h ago",
    unread: false,
    archived: false,
    kind: "member",
  },
  {
    id: "n4",
    title: "Token expiring",
    body: "Service token tk_prod_9f2 expires in 3 days.",
    time: "Yesterday",
    unread: false,
    archived: false,
    kind: "security",
  },
  {
    id: "n5",
    title: "Run failed",
    body: "Run #4205 failed: upstream timeout after 30s. Retried once.",
    time: "2h ago",
    unread: true,
    archived: false,
    kind: "run",
  },
  {
    id: "n6",
    title: "Weekly digest",
    body: "Your workspace ran 142 playbooks this week — 98% succeeded.",
    time: "3d ago",
    unread: false,
    archived: true,
    kind: "system",
  },
  {
    id: "n7",
    title: "Plan limit reached",
    body: "Production hit 90% of its monthly run quota.",
    time: "5d ago",
    unread: false,
    archived: true,
    kind: "system",
  },
  {
    id: "n8",
    title: "Access granted",
    body: "You were added to the “Incident Response” role in Acme Inc.",
    time: "1w ago",
    unread: false,
    archived: true,
    kind: "member",
  },
]
