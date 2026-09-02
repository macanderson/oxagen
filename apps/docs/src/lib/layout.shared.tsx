import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { OxagenLogomark } from "@oxagen/ui";

/**
 * Shared layout options (nav title, links) consumed by both the docs layout
 * and any future home/landing layout.
 *
 * The nav title is the Oxagen brand lockup: the nebula-gradient ring logomark +
 * the "Oxagen" wordmark in Aeonik Fono, with a muted "Docs" qualifier.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2">
          <OxagenLogomark className="size-5" />
          <span className="ox-wordmark text-lg text-foreground">Oxagen</span>
          <span className="text-sm font-medium text-muted-foreground">
            Docs
          </span>
        </span>
      ),
    },
  };
}
