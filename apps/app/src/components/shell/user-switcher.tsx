"use client";
/**
 * UserSwitcher — the account control pinned to the bottom of the sidenav.
 *
 * Renders a full-width button (avatar + name + email + chevron) that opens a
 * dropdown menu:
 *   Profile  → /account/profile
 *   Settings → /account
 *   Sign out → better-auth client signOut + redirect to /login
 *
 * Theme switching lives in the topbar (ThemeToggle), so it is intentionally not
 * duplicated here. The avatar renders the user's initials when no image is
 * present, or an <img> when one is available.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { User, LogOut, Settings, ChevronsUpDown } from "lucide-react";
import { signOut } from "@oxagen/auth/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface SessionUser {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
}

export interface UserSwitcherProps {
  user: SessionUser;
  className?: string;
}

function initials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      const first = parts[0]?.[0] ?? "";
      const last = parts[parts.length - 1]?.[0] ?? "";
      return `${first}${last}`.toUpperCase();
    }
    return (parts[0]?.[0] ?? "").toUpperCase();
  }
  return (email[0] ?? "").toUpperCase();
}

export function UserSwitcher({ user, className }: UserSwitcherProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = React.useState(false);

  const handleSignOut = React.useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut();
      router.push("/login");
    } finally {
      setSigningOut(false);
    }
  }, [router]);

  const displayName = user.name ?? user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Open account menu for ${displayName}`}
          disabled={signingOut}
          className={cn(
            "flex w-full items-center gap-2 rounded-md p-2 text-left text-sm transition-colors",
            "hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-wait disabled:opacity-60",
            className,
          )}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-xs font-semibold text-muted-foreground">
            {user.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={user.image} alt={displayName} className="h-full w-full object-cover" />
            ) : (
              <span aria-hidden="true">{initials(user.name, user.email)}</span>
            )}
          </span>
          <span className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate font-medium">{displayName}</span>
            <span className="truncate text-xs text-muted-foreground">{user.email}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium leading-tight">{displayName}</span>
            <span className="text-xs font-normal text-muted-foreground leading-tight">
              {user.email}
            </span>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => router.push("/account/profile")}>
          <User className="h-4 w-4" aria-hidden="true" />
          Profile
        </DropdownMenuItem>

        <DropdownMenuItem onSelect={() => router.push("/account")}>
          <Settings className="h-4 w-4" aria-hidden="true" />
          Settings
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => void handleSignOut()}
          disabled={signingOut}
          className="text-destructive data-[highlighted]:text-destructive"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
