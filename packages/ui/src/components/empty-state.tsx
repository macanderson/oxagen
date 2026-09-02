import * as React from "react";
import { cn } from "../lib/utils";

/*
 * EmptyState — the shared "nothing here yet" block.
 *
 * One consistent shape for zero-data moments: a muted icon tile, a short
 * title, one supporting line, and the action that creates the first thing.
 * Compact by design — `size="sm"` for inline panels/table bodies, default for
 * page-level empties. Enters with the shared `.animate-in` rise.
 *
 *   <EmptyState
 *     icon={<Database />}
 *     title="No connections yet"
 *     description="Connect a source to start grounding answers."
 *     action={<Button size="sm">Add connection</Button>}
 *   />
 */
export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Lucide icon element; auto-sized and muted. */
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary (and optionally secondary) call to action. */
  action?: React.ReactNode;
  size?: "sm" | "default";
  /**
   * Container treatment: `plain` for inside an existing Panel/Card, `dashed`
   * for a standalone drop-target-style block, `muted` for a soft filled block.
   */
  variant?: "plain" | "dashed" | "muted";
}

const variantClass = {
  plain: "",
  dashed: "rounded-xl border border-dashed border-border bg-card/50",
  muted: "rounded-xl border border-border/40 bg-muted/20",
} as const;

const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      className,
      icon,
      title,
      description,
      action,
      size = "default",
      variant = "plain",
      ...props
    },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        "animate-in flex flex-col items-center justify-center text-center",
        size === "default" ? "gap-1.5 px-6 py-10" : "gap-1 px-4 py-6",
        variantClass[variant],
        className,
      )}
      {...props}
    >
      {icon && (
        <div
          aria-hidden="true"
          className={cn(
            "mb-1.5 flex items-center justify-center rounded-lg bg-muted text-muted-foreground",
            size === "default"
              ? "size-10 [&_svg]:size-5"
              : "size-8 [&_svg]:size-4",
          )}
        >
          {icon}
        </div>
      )}
      <div
        className={cn(
          "font-medium text-foreground",
          size === "default" ? "text-sm" : "text-xs",
        )}
      >
        {title}
      </div>
      {description && (
        <p
          className={cn(
            "max-w-sm text-muted-foreground",
            size === "default" ? "text-sm" : "text-xs",
          )}
        >
          {description}
        </p>
      )}
      {action && <div className="mt-2.5 flex items-center gap-2">{action}</div>}
    </div>
  ),
);
EmptyState.displayName = "EmptyState";

export { EmptyState };
