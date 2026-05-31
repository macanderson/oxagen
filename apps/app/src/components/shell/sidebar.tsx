import Link from "next/link";
import { MessageSquare, Settings, Users, Workflow, Bot, Activity, CreditCard } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SidebarProps {
  orgSlug: string;
  workspaceSlug?: string;
}

export const workspaceNav = [
  { href: "chat", label: "Chat", icon: MessageSquare },
  { href: "agents", label: "Agents", icon: Bot },
  { href: "playbooks", label: "Playbooks", icon: Workflow },
  { href: "executions", label: "Executions", icon: Activity },
  { href: "settings", label: "Settings", icon: Settings },
];

export const orgNav = [
  { href: "settings/billing", label: "Billing", icon: CreditCard },
  { href: "settings/members", label: "Members", icon: Users },
];

/** Desktop sidebar — hidden on mobile, visible at `md` and above. */
export function Sidebar({ orgSlug, workspaceSlug }: SidebarProps) {
  return (
    <aside className="hidden h-full w-64 flex-col gap-1 border-r border-border/40 bg-background/30 p-3 backdrop-blur-xl md:flex">
      {workspaceSlug ? (
        <>
          <div className="px-2 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Workspace</div>
          {workspaceNav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={`/${orgSlug}/${workspaceSlug}/${href}`}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          ))}
          <div className="mt-4 px-2 pb-1 text-xs uppercase tracking-wider text-muted-foreground">Organization</div>
        </>
      ) : null}
      {orgNav.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={`/${orgSlug}/${href}`}
          className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground"
        >
          <Icon className="h-4 w-4" />
          {label}
        </Link>
      ))}
    </aside>
  );
}

/** Mobile bottom tab bar — visible below `md`, hidden at `md` and above. */
export function MobileBottomBar({ orgSlug, workspaceSlug }: SidebarProps) {
  if (!workspaceSlug) return null;

  // Show the five primary workspace tabs; org-level links live in the drawer.
  const primaryNav = workspaceNav;

  return (
    <nav
      aria-label="Mobile navigation"
      className={cn(
        "fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-border/40",
        "bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl",
        "md:hidden",
      )}
    >
      {primaryNav.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={`/${orgSlug}/${workspaceSlug}/${href}`}
          className={cn(
            "flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-2 text-muted-foreground",
            "transition-colors hover:text-foreground active:scale-95",
          )}
        >
          <Icon className="h-5 w-5 shrink-0" />
          <span className="truncate text-[10px] font-medium">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
