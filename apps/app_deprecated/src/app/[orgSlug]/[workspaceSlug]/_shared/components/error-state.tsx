"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ErrorState — Phase-0 shared error block.
 *
 * Designed to be usable directly from a route `error.tsx` boundary (Next.js
 * passes `reset`, which can be forwarded as `retry`):
 *
 *   "use client";
 *   export default function Error({ reset }: { error: Error; reset: () => void }) {
 *     return <ErrorState retry={reset} />;
 *   }
 */
export interface ErrorStateProps {
  title?: string;
  description?: string;
  retry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description,
  retry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="mb-1.5 flex size-10 items-center justify-center rounded-lg bg-error/10 text-error [&_svg]:size-5"
      >
        <AlertTriangle />
      </div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {retry && (
        <div className="mt-2.5">
          <Button size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
