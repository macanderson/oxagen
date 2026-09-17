import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * EmptyState — Phase-0 shared "nothing here yet" block for route shells.
 *
 * Server-safe (no hooks). Centered muted icon in a soft rounded tile, a
 * title, an optional description, and an optional action node below.
 *
 *   <EmptyState
 *     icon={Database}
 *     title="No connections yet"
 *     description="Connect a source to start grounding answers."
 *     action={<Button size="sm">Add connection</Button>}
 *   />
 */
export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center",
        className,
      )}
    >
      {Icon && (
        <div
          aria-hidden="true"
          className="mb-1.5 flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5"
        >
          <Icon />
        </div>
      )}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2.5 flex items-center gap-2">{action}</div>}
    </div>
  );
}
