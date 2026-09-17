"use client";
// The user menu behind the avatar (mockup `userMenu()`): who is signed in and
// the theme switch.
//
// The trigger draws `viewer.avatarUrl` through the app's one avatar renderer
// (src/ui/avatar.tsx), which falls back to initials when the person has set no
// avatar or the stored value is malformed. It read the name and the email and
// nothing else before, so the Account dialog's avatar field was write-only
// from the chrome's point of view: no branch here could ever draw one, and a
// full reload did not help — the value came back from the session and was
// thrown away at the last step.
import { Menu } from "@base-ui/react/menu";
import { useTranslations } from "next-intl";
import { Avatar } from "@/ui/avatar";
import { initials } from "./format";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { nextTheme } from "./theme";

const itemClass =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm text-menu-item-fg outline-none data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg";

export function UserMenu({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const { theme, setTheme, setAccountOpen } = useShellState();
  const { viewer } = data;
  const displayName = viewer.name ?? viewer.email;
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
          size="trigger"
          testId="user-menu-avatar"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup className="min-w-56 rounded-lg border border-menu-popup-border bg-menu-popup-bg p-1 text-menu-popup-fg shadow-lg outline-none">
            <div className="border-b border-menu-separator px-2.5 pb-2 pt-1.5">
              <p className="text-sm font-semibold">{displayName}</p>
              <p className="text-xs text-muted-foreground">{viewer.email}</p>
            </div>
            <Menu.Item
              className={itemClass}
              data-testid="open-account"
              onClick={() => {
                setAccountOpen(true);
              }}
            >
              <span className="flex-1">{t("userMenu.account")}</span>
            </Menu.Item>
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
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
