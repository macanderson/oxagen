"use client";
// The pager under a list that pages by address (#4693): the shared RowsPager,
// with Rows per page on the left beside the range, and Previous and Next on
// the right.
//
// The server works out every page this pager can reach, as the audit record
// does in features/audit/events.tsx. Previous and Next arrive as addresses and
// draw as links, which keeps a middle click, a copied link and a browser with
// no script working. A server component cannot pass a function to this one,
// so each size Rows offers arrives as the address of its first page, and
// picking a size visits that address.
import type { ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { RowsPager } from "@/ui/pagination";

/** A size Rows offers, and the first page of the list at that size. */
type LinkPagerSize = { size: number; first: SafePath };

export type LinkPagerProps = {
  /** The pager's name as a landmark. */
  label: string;
  rowsLabel: string;
  previousLabel: string;
  nextLabel: string;
  /** The size this page was read at, one of `sizes`. */
  perPage: number;
  sizes: readonly LinkPagerSize[];
  range?: ReactNode;
  /** The page before this one, or null on the first page. */
  previous: SafePath | null;
  /** The page after this one, or null when no later page is known. */
  next: SafePath | null;
  /** Classes on the pager's row, such as the inset of the panel it sits in. */
  className?: string;
};

export function LinkPager({
  label,
  rowsLabel,
  previousLabel,
  nextLabel,
  perPage,
  sizes,
  range,
  previous,
  next,
  className,
}: LinkPagerProps) {
  const navigate = useNavigate();
  return (
    <RowsPager
      label={label}
      rowsLabel={rowsLabel}
      perPage={perPage}
      sizes={sizes.map((option) => option.size)}
      onPerPage={(size) => {
        // Picking the size already showing keeps the reader on this page.
        if (size === perPage) return;
        const first = sizes.find((option) => option.size === size)?.first;
        if (first !== undefined) navigate.push(first);
      }}
      range={range}
      previousLabel={previousLabel}
      nextLabel={nextLabel}
      previous={previous}
      next={next}
      className={className}
    />
  );
}
