import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { OxagenWordmark } from "@oxagen/ui";

/**
 * Shared layout options (nav title, links) consumed by both the docs layout
 * and any future home/landing layout.
 *
 * The nav title is the Oxagen WORDMARK plus a muted "Docs" qualifier. The Ox
 * lettermark is deliberately not placed beside it: Oxagen's logo is the
 * wordmark, and mark-then-word is the lockup the brand system does not use.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2">
          <OxagenWordmark className="h-5" />
          <span className="text-sm font-medium text-muted-foreground">
            Docs
          </span>
        </span>
      ),
    },
  };
}
