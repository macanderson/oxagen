"use client";
// The user menu behind the avatar (mockup `userMenu()`): who is signed in,
// the four tabs of the Account dialog as deep links, the theme switch, and
// sign out. The mockup's fifth link is an onboarding demo and is not a
// product item.
//
// The trigger draws `viewer.avatarUrl` through the app's one avatar renderer
// (src/ui/avatar.tsx), which falls back to initials when the person has set no
// avatar or the stored value is malformed.
import { Menu } from "@base-ui/react/menu";
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { Avatar } from "@/ui/avatar";
import { useNavigate } from "@/ui/navigation";
import { initials } from "./format";
import { liveSignOut } from "./session-client";
import type { ShellData } from "./shell-data";
import { type AccountTab, useShellState } from "./shell-state";
import { nextTheme } from "./theme";

const itemClass =
  "flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-menu-item-fg outline-none data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg";

const LINKS: readonly { tab: AccountTab; testId: string }[] = [
  { tab: "profile", testId: "open-account" },
  { tab: "preferences", testId: "open-preferences" },
  { tab: "security", testId: "open-security" },
  { tab: "privacy", testId: "open-privacy" },
];

export function UserMenu({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const navigate = useNavigate();
  const { theme, setTheme, openAccount, exitHeld } = useShellState();
  const { viewer } = data;
  const displayName = viewer.name ?? viewer.email;

  async function signOut() {
    // Signing out leaves the shell, which unmounts the Account dialog and the
    // only copy of a recovery-code set Better Auth has already swapped in for
    // the old one. A client-side `replace` runs no `beforeunload`, so the
    // browser cannot ask. While codes are at stake the menu takes the person
    // back to them instead; sign out works again once they are saved.
    if (exitHeld) {
      openAccount("security");
      return;
    }
    try {
      await liveSignOut();
    } finally {
      // The session is gone either way once Better Auth answers; the login
      // page is where a signed-out person belongs, and `replace` re-renders
      // the server tree so no chrome for the old session survives.
      navigate.replace(routes.login());
    }
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="user-menu-trigger"
        aria-label={t("topbar.userMenu", { name: displayName })}
        className="flex rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Avatar
          value={viewer.avatarUrl}
          initials={initials(displayName)}
          size={30}
          testId="user-menu-avatar"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup className="w-[250px] rounded-xl border border-menu-popup-border bg-menu-popup-bg p-1.5 text-menu-popup-fg shadow-lg outline-none">
            <div className="mb-1 border-b border-menu-separator px-2.5 pb-2 pt-1.5">
              <p className="truncate text-sm font-semibold">{displayName}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {viewer.email}
              </p>
            </div>
            {LINKS.map(({ tab, testId }) => (
              <Menu.Item
                key={tab}
                className={itemClass}
                data-testid={testId}
                onClick={() => {
                  openAccount(tab);
                }}
              >
                <span className="flex-1">{t(`userMenu.${tab}`)}</span>
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-menu-separator" />
            <Menu.Item
              className={itemClass}
              closeOnClick={false}
              data-testid="switch-theme"
              onClick={() => {
                setTheme(nextTheme(theme));
              }}
            >
              <span className="flex-1">{t("userMenu.switchTheme")}</span>
              <span className="text-xs text-muted-foreground">
                {t("userMenu.themeNow", { theme })}
              </span>
            </Menu.Item>
            <Menu.Item
              className={itemClass}
              data-testid="sign-out"
              onClick={() => void signOut()}
            >
              <span className="flex-1">{t("userMenu.signOut")}</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
