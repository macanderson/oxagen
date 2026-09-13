import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The announceable wrapper every skeleton belongs in.
 *
 * The skeletons in this folder are all `aria-hidden` — a screen reader has
 * nothing useful to say about grey boxes. This supplies the one thing it does
 * need: a live `role="status"` region with a `label` naming what is loading
 * ("Loading environments"). Wrap the skeleton, don't hand-roll the roles.
 */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn(className)}
    >
      {children}
    </div>
  );
}
