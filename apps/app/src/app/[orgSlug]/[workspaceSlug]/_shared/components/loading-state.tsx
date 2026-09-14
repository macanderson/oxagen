import {
  TableSkeleton,
  CardGridSkeleton,
  DetailSkeleton,
  PageHeaderSkeleton,
} from "@/components/loading";
import { cn } from "@/lib/utils";

/**
 * LoadingState — Phase-0 shared loading delegator.
 *
 * Thin variant switch over the existing `@/components/loading/*` skeletons —
 * does not reimplement skeleton markup. Default variant "page".
 */
export interface LoadingStateProps {
  variant?: "table" | "cards" | "detail" | "page";
  className?: string;
}

export function LoadingState({
  variant = "page",
  className,
}: LoadingStateProps) {
  return (
    <div className={cn(className)}>
      {variant === "table" && <TableSkeleton />}
      {variant === "cards" && <CardGridSkeleton />}
      {variant === "detail" && <DetailSkeleton />}
      {variant === "page" && <PageHeaderSkeleton />}
    </div>
  );
}
