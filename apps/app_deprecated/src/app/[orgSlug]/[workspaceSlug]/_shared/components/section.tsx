import { Suspense } from "react";
import { cn } from "@/lib/utils";
import { LoadingState } from "./loading-state";

/**
 * Section — Suspense-per-section wrapper for route shells.
 *
 * Wraps async children in a `Suspense` boundary so one slow section doesn't
 * block sibling sections from streaming in. Defaults the fallback to
 * `<LoadingState variant="page" />`.
 */
export interface SectionProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  className?: string;
}

export function Section({ children, fallback, className }: SectionProps) {
  return (
    <div className={cn(className)}>
      <Suspense fallback={fallback ?? <LoadingState variant="page" />}>
        {children}
      </Suspense>
    </div>
  );
}
