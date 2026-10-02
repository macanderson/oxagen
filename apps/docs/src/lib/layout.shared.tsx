import Link from "fumadocs-core/link";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { OxagenWordmark } from "@oxagen/ui";
import type { ComponentProps } from "react";
import { SidebarThemeSwitcher } from "@/components/theme-switcher";

/**
 * The nav title link: the Oxagen WORDMARK plus a muted "Docs" qualifier. The
 * Ox lettermark is deliberately not placed beside it: Oxagen's logo is the
 * wordmark, and mark-then-word is the lockup the brand system does not use.
 *
 * Fumadocs calls this with the link's props, and in the docs sidebar those
 * carry a fixed 15px size (`text-[0.9375rem]`) that no theme change reaches.
 * The `ox-nav-title` class is the hook src/app/global.css uses to give the
 * link the sidebar's size from the kit's tokens, in the sidebar and in the
 * docs header. The "Docs" qualifier takes the link's size.
 */
function NavTitle({ className, ...props }: ComponentProps<"a">) {
  return (
    <Link {...props} className={className ? `${className} ox-nav-title` : "ox-nav-title"}>
      <span className="inline-flex items-center gap-2">
        <OxagenWordmark className="h-5" />
        <span className="font-medium text-muted-foreground">Docs</span>
      </span>
    </Link>
  );
}

/**
 * Shared layout options (nav title, links) consumed by both the docs layout
 * and any future home/landing layout.
 *
 * The theme control is the same System / Light / Dark pill the landing
 * footer and oxagen.sh carry, in place of Fumadocs' two-state toggle.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    slots: { themeSwitch: SidebarThemeSwitcher },
    nav: { title: NavTitle },
  };
}
