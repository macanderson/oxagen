import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Tile — bordered rounded card primitive for grid/menu layouts.
 *
 * Composes `@/components/ui/card`. When `href` is set the whole tile is a
 * Next `Link` with hover affordance; otherwise it's a static container.
 */
export interface TileProps {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  href?: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function Tile({
  title,
  description,
  icon: Icon,
  href,
  footer,
  children,
  className,
}: TileProps) {
  const content = (
    <>
      {Icon && (
        <div
          aria-hidden="true"
          className="mb-3 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5"
        >
          <Icon />
        </div>
      )}
      {title && (
        <div className="text-sm font-medium text-foreground">{title}</div>
      )}
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      {children && (
        <div className={cn(title || description ? "mt-3" : undefined)}>
          {children}
        </div>
      )}
      {footer && (
        <div className="mt-3 border-t border-border pt-3">{footer}</div>
      )}
    </>
  );

  if (href) {
    return (
      <Card interactive className={cn("p-0", className)}>
        <Link href={href} className="block p-4">
          {content}
        </Link>
      </Card>
    );
  }

  return <Card className={cn("p-4", className)}>{content}</Card>;
}
