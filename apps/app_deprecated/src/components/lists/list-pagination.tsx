"use client";

/**
 * list-pagination.tsx — compact Prev / "Page x of y" / Next control for
 * `useListControls`-backed lists. Renders nothing when there is only one
 * page (`pageCount <= 1`), so pages that never need paging never render an
 * empty bar.
 *
 *   const controls = useListControls(rows, { ... });
 *   <ListPagination page={controls.page} pageCount={controls.pageCount} onPageChange={controls.setPage} />
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ListPaginationProps {
  /** Current 1-indexed page — from `useListControls().page`. */
  page: number;
  /** Total page count — from `useListControls().pageCount`. */
  pageCount: number;
  /** Called with the next page number — pass `useListControls().setPage`. */
  onPageChange: (page: number) => void;
  className?: string;
}

export function ListPagination({
  page,
  pageCount,
  onPageChange,
  className,
}: ListPaginationProps) {
  if (pageCount <= 1) return null;

  const canPrev = page > 1;
  const canNext = page < pageCount;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 sm:justify-end",
        className,
      )}
      data-testid="list-pagination"
    >
      {/* size="default" (32px) rather than the "sm" density used elsewhere in
          list toolbars — pagination controls are tapped repeatedly on mobile,
          so they get the more touch-friendly of the two compact sizes. */}
      <Button
        type="button"
        variant="outline"
        size="default"
        disabled={!canPrev}
        onClick={() => onPageChange(page - 1)}
        aria-label="Previous page"
        startIcon={<ChevronLeft aria-hidden="true" />}
      >
        Prev
      </Button>
      <span
        className="text-sm text-muted-foreground tabular-nums"
        aria-live="polite"
      >
        Page {page} of {pageCount}
      </span>
      <Button
        type="button"
        variant="outline"
        size="default"
        disabled={!canNext}
        onClick={() => onPageChange(page + 1)}
        aria-label="Next page"
        endIcon={<ChevronRight aria-hidden="true" />}
      >
        Next
      </Button>
    </div>
  );
}
