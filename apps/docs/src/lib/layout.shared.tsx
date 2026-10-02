import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { NavTitle } from "@/components/docs/nav-title";
import { SidebarThemeSwitcher } from "@/components/theme-switcher";

/**
 * Shared layout options (nav title, links) consumed by both the docs layout
 * and any future home/landing layout.
 *
 * The nav title is a client component (src/components/docs/nav-title.tsx).
 * The theme control is the same System / Light / Dark pill the landing
 * footer and oxagen.sh carry, in place of Fumadocs' two-state toggle.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    slots: { themeSwitch: SidebarThemeSwitcher },
    nav: { title: NavTitle },
  };
}
