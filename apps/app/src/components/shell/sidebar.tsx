import Link from "next/link";
import { MessageSquare, Settings, Users, Workflow, Bot, Activity, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SidebarProps {
  tenantSlug: string;
  workspaceSlug?: string;
}

const workspaceNav = [
  { href: "chat", label: "Chat", icon: MessageSquare },
  { href: "agents", label: "Agents", icon: Bot },
  { href: "playbooks", label: "Playbooks", icon: Workflow },
  { href: "executions", label: "Executions", icon: Activity },
  { href: "settings", label: "Settings", icon: Settings },
];

const tenantNav = [
  { href: "settings/billing", label: "Billing", icon: CreditCard },
  { href: "settings/members", label: "Members", icon: Users },
];

export function Sidebar({ tenantSlug, workspaceSlug }: SidebarProps) {
  return (
    <aside className="hidden h-full w-64 flex-col gap-1 border-r border-border/40 bg-background/30 p-3 backdrop-blur-xl md:flex">
      {workspaceSlug ? (
        <>
          <div className="px-2 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Workspace</div>
          {workspaceNav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={`/${tenantSlug}/${workspaceSlug}/${href === "" ? "" : href}`}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
          <div className="mt-4 px-2 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Tenant</div>
        </>
      ) : null}
      {tenantNav.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={`/${tenantSlug}/${href}`}
          className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </aside>
  );
}
