"use client";
// The user menu behind the avatar (mockup `userMenu()`): who is signed in and
// the theme switch.
import { Menu } from "@base-ui/react/menu";
import { useTranslations } from "next-intl";
import { initials } from "./format";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { nextTheme } from "./theme";

const itemClass =
  "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm text-menu-item-fg outline-none data-[highlighted]:bg-menu-item-highlighted-bg data-[highlighted]:text-menu-item-highlighted-fg";

export function UserMenu({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const { theme, setTheme } = useShellState();
  const viewer = data.context.ok ? data.context.value.viewer : null;
  return (
    <Menu.Root>
      <Menu.Trigger
        data-testid="user-menu-trigger"
        aria-label={
          viewer === null
            ? t("topbar.userMenuUnknown")
            : t("topbar.userMenu", { name: viewer.name })
        }
        className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true">
          {viewer === null ? "?" : initials(viewer.name)}
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup className="min-w-56 rounded-lg border border-menu-popup-border bg-menu-popup-bg p-1 text-menu-popup-fg shadow-lg outline-none">
            {viewer === null ? null : (
              <div className="border-b border-menu-separator px-2.5 pb-2 pt-1.5">
                <p className="text-sm font-semibold">{viewer.name}</p>
                <p className="text-xs text-muted-foreground">{viewer.email}</p>
              </div>
            )}
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
