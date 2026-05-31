import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/**
 * Shared layout options (nav title, links) consumed by both the docs layout
 * and any future home/landing layout.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Oxagen Docs",
    },
  };
}
