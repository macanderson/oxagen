"use client";
// The Runs panel's pager (fleet.md, "1–10 of 279" with page buttons to the
// last page). The total is the read's: every run the filters and the search
// let through, across the workspace (#3837). Past the read's count bound the
// total reads as the bound with a plus sign, and the buttons stop at the last
// page an offset can reach.
//
// A read that did not count (a pull-request filter, which only the frames
// answer, or a count that failed) has no total to page against, so the pager
// falls back to the cursor: the rows this read returned, and a link to older
// runs when more follow.
import { useLocale, useTranslations } from "next-intl";
import type { PullRequestFilter } from "@/data/contracts/runs";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import {
  type FleetListQuery,
  lastReachablePage,
  listQueryToRoute,
  pageRange,
} from "./list-query";

/** Pages shown either side of the current one before a gap. */
const WINDOW = 1;

/** A page button, or a gap after the page it follows. */
export type PageButton = { page: number } | { gapAfter: number };

/**
 * The buttons a pager draws: the first page, the pages around the current
 * one, and the last when it is known, with a gap wherever pages are skipped.
 * Exported for its test.
 *
 * @internal
 */
export function pageButtons(
  page: number,
  pages: number,
  lastKnown: boolean,
): PageButton[] {
  const shown = new Set<number>([1, page]);
  for (let n = page - WINDOW; n <= page + WINDOW; n += 1)
    if (n >= 1 && n <= pages) shown.add(n);
  if (lastKnown) shown.add(pages);
  const sorted = [...shown].filter((n) => n <= pages).sort((a, b) => a - b);
  const out: PageButton[] = [];
  let prev: number | null = null;
  for (const n of sorted) {
    if (prev !== null && n - prev > 1) out.push({ gapAfter: prev });
    out.push({ page: n });
    prev = n;
  }
  if (!lastKnown && prev !== null && prev < pages) out.push({ gapAfter: prev });
  return out;
}

export function RunsPager({
  list,
  pageSize,
  rows,
  total,
  totalBound,
  cursor,
  nextCursor,
  pullRequests,
  org,
  ws,
}: {
  list: FleetListQuery;
  pageSize: number;
  /** Rows this read returned. */
  rows: number;
  /** The read's total; null past `totalBound`; absent when it did not count. */
  total?: number | null;
  totalBound?: number;
  cursor: string | null;
  nextCursor: string | null;
  pullRequests: PullRequestFilter;
  org: string;
  ws: string;
}) {
  const t = useTranslations("fleet.runs.pager");
  const locale = useLocale();
  const count = (n: number) => formatCount(n, locale);
  const toPage = (page: number) =>
    routes.fleet(org, ws, listQueryToRoute({ ...list, page }, pullRequests));
  const { from, to } = pageRange(list, pageSize, rows);

  if (total === undefined) {
    // No count: the rows of this read, and the cursor to the next.
    const range =
      rows === 0
        ? t("none")
        : t(nextCursor === null ? "range" : "rangeMore", {
            from: count(from),
            to: count(to),
            total: count(to),
          });
    return (
      <nav
        aria-label={t("label")}
        className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground"
      >
        <span data-testid="pager-range" className="font-mono tabular-nums">
          {range}
        </span>
        <span className="ms-auto flex flex-wrap items-center gap-3">
          {cursor === null ? null : (
            <SafeLink
              to={routes.fleet(org, ws, { prs: pullRequests })}
              data-touch-target=""
              className={`${linkText} inline-flex items-center`}
            >
              {t("newest")}
            </SafeLink>
          )}
          {nextCursor === null ? null : (
            <SafeLink
              to={routes.fleet(org, ws, {
                ...listQueryToRoute(list, pullRequests),
                cursor: nextCursor,
              })}
              data-touch-target=""
              className={`${linkText} inline-flex items-center`}
            >
              {t("older")}
            </SafeLink>
          )}
        </span>
      </nav>
    );
  }

  const reachable = lastReachablePage(pageSize);
  const pages =
    total === null
      ? reachable
      : Math.min(Math.max(1, Math.ceil(total / pageSize)), reachable);
  const range =
    rows === 0
      ? total === null || total > 0
        ? t("rangeEmpty", { total: count(total ?? totalBound ?? 0) })
        : t("none")
      : total === null
        ? t("rangeMore", {
            from: count(from),
            to: count(to),
            total: count(totalBound ?? 0),
          })
        : t("range", { from: count(from), to: count(to), total: count(total) });
  const page = list.page;
  const hasNext = page < pages && (total !== null || rows === pageSize);
  const link = `${linkText} inline-flex min-w-6 items-center justify-center`;
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-2 px-3 py-2 text-[11.5px] text-muted-foreground"
    >
      <span data-testid="pager-range" className="font-mono tabular-nums">
        {range}
      </span>
      <ol
        data-testid="pager-pages"
        className="ms-auto flex flex-wrap items-center gap-2"
      >
        {page > 1 ? (
          <li>
            <SafeLink
              to={toPage(page - 1)}
              data-touch-target=""
              className={link}
            >
              {t("previous")}
            </SafeLink>
          </li>
        ) : null}
        {pageButtons(page, pages, total !== null).map((button) =>
          "gapAfter" in button ? (
            // A gap has no page of its own, so it is a mark and not a link.
            <li key={`gap-${String(button.gapAfter)}`} aria-hidden>
              …
            </li>
          ) : (
            <li key={button.page}>
              {button.page === page ? (
                <span
                  aria-current="page"
                  data-testid="pager-current"
                  className="inline-flex min-w-6 items-center justify-center rounded border border-rule px-1 font-mono font-semibold text-foreground tabular-nums"
                >
                  {count(button.page)}
                </span>
              ) : (
                <SafeLink
                  to={toPage(button.page)}
                  aria-label={t("page", { page: count(button.page) })}
                  data-touch-target=""
                  className={`${link} font-mono tabular-nums`}
                >
                  {count(button.page)}
                </SafeLink>
              )}
            </li>
          ),
        )}
        {hasNext ? (
          <li>
            <SafeLink
              to={toPage(page + 1)}
              data-touch-target=""
              className={link}
            >
              {t("next")}
            </SafeLink>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
