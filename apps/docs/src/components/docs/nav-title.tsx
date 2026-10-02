"use client";

import Link from "fumadocs-core/link";
import { OxagenWordmark } from "@oxagen/ui";
import type { ComponentProps } from "react";

/**
 * The nav title link: the Oxagen wordmark plus a muted "Docs" qualifier. The
 * Ox lettermark is not placed beside it: Oxagen's logo is the wordmark, and
 * mark-then-word is a lockup the brand system does not use.
 *
 * Fumadocs calls `nav.title` with the link's props, and in the docs sidebar
 * those carry a fixed 15px size (`text-[0.9375rem]`) that no theme change
 * reaches. The `ox-nav-title` class is the hook src/app/global.css uses to
 * give the link the sidebar's size from the kit's tokens, in the sidebar and
 * in the docs header. The "Docs" qualifier takes the link's size.
 *
 * This is a client module because the docs layout is a server component, and
 * a server component can hand a client component only a client reference,
 * never a plain function.
 */
export function NavTitle({ className, ...props }: ComponentProps<"a">) {
  return (
    <Link {...props} className={className ? `${className} ox-nav-title` : "ox-nav-title"}>
      <span className="inline-flex items-center gap-2">
        <OxagenWordmark className="h-5" />
        <span className="font-medium text-muted-foreground">Docs</span>
      </span>
    </Link>
  );
}
