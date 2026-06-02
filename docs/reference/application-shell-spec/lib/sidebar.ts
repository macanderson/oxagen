import type { LucideIcon } from "lucide-react"
import {
  Activity,
  ArrowLeft,
  Bell,
  BookOpen,
  CreditCard,
  EyeOff,
  KeyRound,
  LayoutGrid,
  LifeBuoy,
  Lock,
  MessageSquare,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  User,
  Users,
  Workflow,
} from "lucide-react"
import type { ScopeContext, ShellMode } from "./scope"

export type SidebarItemConfig = {
  id: string
  label: string
  icon: LucideIcon
  href: (ctx: ScopeContext) => string
  group?: "primary" | "tools" | "footer"
  badge?: (ctx: ScopeContext) => number | null
  external?: boolean
  isReturn?: boolean
}

export type SidebarConfig = {
  mode: Exclude<ShellMode, "pre-shell">
  groupLabel?: string
  toolsLabel?: string
  items: SidebarItemConfig[]
}

const workspaceConfig: SidebarConfig = {
  mode: "workspace",
  groupLabel: "Workspace",
  toolsLabel: "Tools",
  items: [
    {
      id: "ask",
      label: "Ask",
      icon: MessageSquare,
      group: "primary",
      external: true,
      href: ({ org, ws }) => `/${org}/${ws}/ask`,
    },
    {
      id: "knowledge",
      label: "Knowledge",
      icon: BookOpen,
      group: "primary",
      href: ({ org, ws }) => `/${org}/${ws}/knowledge`,
    },
    {
      id: "automation",
      label: "Automation",
      icon: Workflow,
      group: "primary",
      href: ({ org, ws }) => `/${org}/${ws}/automation`,
    },
    {
      id: "activity",
      label: "Activity",
      icon: Activity,
      group: "primary",
      badge: () => 3,
      href: ({ org, ws }) => `/${org}/${ws}/activity`,
    },
    {
      id: "studio",
      label: "Studio",
      icon: Sparkles,
      group: "tools",
      href: ({ org, ws }) => `/${org}/${ws}/studio`,
    },
    {
      id: "settings",
      label: "Settings",
      icon: Settings,
      group: "footer",
      href: ({ org, ws }) => `/${org}/${ws}/settings`,
    },
  ],
}

const orgConfig: SidebarConfig = {
  mode: "org",
  groupLabel: "Organization",
  items: [
    {
      id: "workspaces",
      label: "Workspaces",
      icon: LayoutGrid,
      group: "primary",
      external: true,
      href: ({ org }) => `/${org}/workspaces`,
    },
    {
      id: "members",
      label: "Members",
      icon: Users,
      group: "primary",
      badge: () => 2,
      href: ({ org }) => `/${org}/members`,
    },
    {
      id: "access",
      label: "Access",
      icon: KeyRound,
      group: "primary",
      badge: () => 5,
      href: ({ org }) => `/${org}/access`,
    },
    {
      id: "security",
      label: "Security",
      icon: ShieldCheck,
      group: "primary",
      href: ({ org }) => `/${org}/security`,
    },
    {
      id: "billing",
      label: "Billing",
      icon: CreditCard,
      group: "primary",
      href: ({ org }) => `/${org}/billing`,
    },
    {
      id: "developer",
      label: "Developer",
      icon: Terminal,
      group: "primary",
      href: ({ org }) => `/${org}/developer`,
    },
  ],
}

const accountConfig: SidebarConfig = {
  mode: "account",
  groupLabel: "Account",
  items: [
    {
      id: "back",
      label: "Back to app",
      icon: ArrowLeft,
      group: "primary",
      isReturn: true,
      href: ({ org, ws }) => (org && ws ? `/${org}/${ws}/ask` : "/"),
    },
    {
      id: "profile",
      label: "Profile",
      icon: User,
      group: "primary",
      href: () => `/account/profile`,
    },
    {
      id: "security",
      label: "Security",
      icon: Lock,
      group: "primary",
      href: () => `/account/security`,
    },
    {
      id: "cases",
      label: "Cases",
      icon: LifeBuoy,
      group: "primary",
      href: () => `/account/cases`,
    },
    {
      id: "notifications",
      label: "Notifications",
      icon: Bell,
      group: "primary",
      href: () => `/account/notifications`,
    },
    {
      id: "privacy",
      label: "Privacy",
      icon: EyeOff,
      group: "primary",
      href: () => `/account/privacy`,
    },
  ],
}

export const sidebarRegistry: Record<Exclude<ShellMode, "pre-shell">, SidebarConfig> = {
  workspace: workspaceConfig,
  org: orgConfig,
  account: accountConfig,
}
