"use client";
/**
 * AvatarMenu — user avatar button that opens a dropdown menu.
 *
 * Items:
 *   Profile  → /account/profile
 *   Theme    → inline submenu reusing ThemeToggle logic
 *   Help     → /account (stub — no external link needed)
 *   Sign out → better-auth client signOut + redirect to /login
 *
 * The avatar renders the user's initials when no avatarUrl is present,
 * or an <img> when one is available.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { User, LogOut, HelpCircle, Sun, Moon, Monitor, ChevronRight } from "lucide-react";
import { useTheme } from "next-themes";
import { signOut } from "@oxagen/auth/client";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
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

export interface AvatarMenuProps {
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

export function AvatarMenu({ user, className }: AvatarMenuProps) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
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
            "relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full",
            "border border-border/60 bg-muted text-sm font-semibold text-muted-foreground",
            "transition-all duration-[160ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
            "hover:border-accent/50 hover:ring-2 hover:ring-ring/30",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-wait disabled:opacity-60",
            className,
          )}
        >
          {user.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.image}
              alt={displayName}
              className="h-full w-full object-cover"
            />
          ) : (
            <span aria-hidden="true">{initials(user.name, user.email)}</span>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium leading-tight">{displayName}</span>
            <span className="text-xs text-muted-foreground leading-tight">{user.email}</span>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => router.push("/account/profile")}>
          <User className="mr-2 h-4 w-4" aria-hidden="true" />
          Profile
        </DropdownMenuItem>

        <DropdownMenuPrimitive.Sub>
          <DropdownMenuPrimitive.SubTrigger
            className={cn(
              "relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 outline-none transition-colors",
              "focus:bg-accent/15 focus:text-accent",
              "data-[state=open]:bg-accent/15",
            )}
          >
            {theme === "dark" ? (
              <Moon className="mr-1 h-4 w-4" aria-hidden="true" />
            ) : theme === "light" ? (
              <Sun className="mr-1 h-4 w-4" aria-hidden="true" />
            ) : (
              <Monitor className="mr-1 h-4 w-4" aria-hidden="true" />
            )}
            <span className="flex-1">Theme</span>
            <ChevronRight className="h-3.5 w-3.5 opacity-50" aria-hidden="true" />
          </DropdownMenuPrimitive.SubTrigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.SubContent
              sideOffset={4}
              className={cn(
                "z-50 min-w-[8rem] overflow-hidden rounded-xl p-1 text-sm shadow-lg",
                "glass",
                "data-[state=open]:animate-in data-[state=closed]:animate-out",
                "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              )}
            >
              <DropdownMenuItem onSelect={() => setTheme("light")}>
                <Sun className="mr-2 h-4 w-4" aria-hidden="true" />
                Light
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme("dark")}>
                <Moon className="mr-2 h-4 w-4" aria-hidden="true" />
                Dark
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTheme("system")}>
                <Monitor className="mr-2 h-4 w-4" aria-hidden="true" />
                System
              </DropdownMenuItem>
            </DropdownMenuPrimitive.SubContent>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Sub>

        <DropdownMenuItem onSelect={() => router.push("/account")}>
          <HelpCircle className="mr-2 h-4 w-4" aria-hidden="true" />
          Help
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => void handleSignOut()}
          disabled={signingOut}
          className="text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
