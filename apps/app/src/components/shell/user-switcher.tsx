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
import { User, LogOut, Settings, ChevronsUpDown, Monitor, Moon, Sun } from "lucide-react";
import { signOut } from "@oxagen/auth/client";
import { useTheme } from "@oxagen/ui";
import {
  Menu,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/utils";

export interface SessionUser {
  id: string;
  name: string | null;
  email: string;
  image?: string | null;
}

export interface UserSwitcherProps {
  /**
   * The authenticated user. May be undefined during a transient post-signup
   * render before the session is fully committed; the component renders nothing
   * in that case rather than crashing.
   */
  user: SessionUser | undefined;
  /**
   * Trigger shape:
   *   "full"   — wide button (avatar + name + email + chevron) for the sidebar.
   *   "avatar" — compact avatar-only button for the topbar.
   */
  variant?: "full" | "avatar";
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

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

export function UserSwitcher({ user, variant = "full", className }: UserSwitcherProps) {
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

  // Defense-in-depth guard: user may be undefined during a transient post-signup
  // render before the session is fully committed. Render nothing rather than crash.
  if (!user) return null;

  const displayName = user.name ?? user.email;

  // The avatar circle is shared by both trigger shapes.
  const avatar = (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full",
        "bg-muted text-xs font-semibold text-muted-foreground",
      )}
    >
      {user.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.image} alt={displayName} className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{initials(user.name, user.email)}</span>
      )}
    </span>
  );

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Open account menu for ${displayName}`}
            disabled={signingOut}
            className={cn(
              variant === "avatar"
                ? // Compact avatar-only trigger (topbar): a focusable ring around the circle.
                  "flex shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-90"
                : // Wide trigger (sidebar): avatar + name + email + chevron.
                  cn(
                    "flex w-full items-center gap-2 rounded-md p-2 text-left text-sm transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                  ),
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-wait disabled:opacity-60",
              className,
            )}
          />
        }
      >
        {avatar}
        {variant === "full" && (
          <>
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </>
        )}
      </MenuTrigger>

      <MenuPopup align="end" side={variant === "avatar" ? "bottom" : "top"} className="w-56">
        <MenuGroupLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium leading-tight">{displayName}</span>
            <span className="text-xs font-normal text-muted-foreground leading-tight">
              {user.email}
            </span>
          </div>
        </MenuGroupLabel>

        <MenuSeparator />

        <MenuItem onClick={() => router.push("/account/profile")}>
          <User className="h-4 w-4" aria-hidden="true" />
          Profile
        </MenuItem>

        <MenuItem onClick={() => router.push("/account")}>
          <Settings className="h-4 w-4" aria-hidden="true" />
          Settings
        </MenuItem>

        <MenuSeparator />

        <MenuGroupLabel className="text-xs font-normal text-muted-foreground">Theme</MenuGroupLabel>
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <MenuItem
            key={value}
            onClick={() => setTheme(value)}
            className={cn(theme === value && "text-foreground")}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="flex-1">{label}</span>
            {theme === value && <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" />}
          </MenuItem>
        ))}

        <MenuSeparator />

        <MenuItem
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          className="text-destructive data-[highlighted]:text-destructive"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
