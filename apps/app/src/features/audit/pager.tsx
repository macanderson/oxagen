"use client";
// The pager under the audit record (#4693): the shared RowsPager, with Rows
// per page on the left beside the range, and Previous and Next on the right.
//
// The record pages by address, so the server works out every page this pager
// can reach (events.tsx). Previous and Next arrive as addresses and draw as
// links, which keeps a middle click, a copied link and a browser with no
// script working. A server component cannot pass a function to this one, so
// each size Rows offers arrives as the address of its first page, and picking
// a size visits that address.
import type { ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { RowsPager } from "@/ui/pagination";

/** A size Rows offers, and the first page of the record at that size. */
type AuditPagerSize = { size: number; first: SafePath };

export function AuditPager({
  label,
  rowsLabel,
  previousLabel,
  nextLabel,
  perPage,
  sizes,
  range,
  previous,
  next,
}: {
  /** The pager's name as a landmark. */
  label: string;
  rowsLabel: string;
  previousLabel: string;
  nextLabel: string;
  /** The size this page was read at, one of `sizes`. */
  perPage: number;
  sizes: readonly AuditPagerSize[];
  range: ReactNode;
  /** The newer page, or null on the first page. */
  previous: SafePath | null;
  /** The older page, or null when no older page is known. */
  next: SafePath | null;
}) {
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
      // The panel's 16 px inset, which the filters above and the note below
      // keep too.
      className="px-4"
    />
  );
}
