// The numbered pager's page list and button style (the mockup's `ltPager`,
// engine.js), shared by the client list table (list-table.tsx) and pagers a
// server component draws as links, such as Audit's Events.

/** A page number, or an ellipsis standing for the pages between two numbers. */
export type PageListItem = number | "gap-before" | "gap-after";

/** The page numbers the pager shows, with an ellipsis on either side past seven pages. */
export function pageList(page: number, pages: number): PageListItem[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pages - 1, page + 1);
  const out: PageListItem[] = [1];
  if (lo > 2) out.push("gap-before");
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < pages - 1) out.push("gap-after");
  out.push(pages);
  return out;
}

/** A pager button or link: the design's `.btn.sm`, gold-edged on the current page, 44 px on a phone. */
export const pagerButton =
  "inline-flex min-h-7 min-w-7 items-center justify-center rounded-[7px] border border-button-default-border bg-button-default-bg px-2 py-0.5 text-[12px] tabular-nums text-button-default-fg hover:bg-button-default-hover-bg disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-default aria-disabled:opacity-40 aria-[current=page]:border-gold aria-[current=page]:text-accent-text max-md:min-h-11 max-md:min-w-11";
