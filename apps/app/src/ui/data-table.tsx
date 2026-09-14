"use client";

// <DataTable>: every list's controls in one client island: a search box,
// sortable headers, facet filters on small enumerations, rows per page and a
// pager. Each control is opt-in by configuration and disappears when its
// config is omitted: no `search`, no search box; no `sortValue` on a column,
// no sort button on its header; no `facetValue`, no filter; no `pageSizes`,
// every row on one page.
//
// Column definitions hold functions, which cannot cross from a Server
// Component to a client one. A page keeps its columns in its own
// "use client" file and passes the rows (plain, serialisable data) in from the
// server, e.g. features/fleet/fleet-table.client.tsx.
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { cx } from "./cx";
import {
  type ColumnModel,
  type SortState,
  applyTableState,
  facetOptions,
  nextSort,
  pageList,
} from "./data-table-model";

export type DataTableColumn<T> = ColumnModel<T> & {
  /** Header text, already translated. */
  header: string;
  cell: (row: T) => ReactNode;
  /** Display text for a facet value (e.g. a translated enum label). */
  facetLabel?: ((value: string) => string) | undefined;
  align?: "start" | "end";
  className?: string | undefined;
};

export type DataTableProps<T> = {
  rows: readonly T[];
  columns: readonly DataTableColumn<T>[];
  getRowId: (row: T) => string;
  /** The table's accessible name. */
  caption: string;
  /** Show the caption visually as well; by default it is for assistive technology only. */
  showCaption?: boolean;
  search?: { placeholder?: string };
  /** Rows-per-page choices; 0 means all. The first is the initial size. */
  pageSizes?: readonly number[];
  initialSort?: SortState;
  /** Rendered in place of the table when there are no rows at all (not when a filter hides them). */
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
};

const controlClass =
  "h-8 rounded-md border border-input-border bg-input-bg px-2 text-sm text-input-fg hover:border-input-border-hover focus-visible:border-input-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-ring";

const pagerButtonClass =
  "inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-button-default-border bg-button-default-bg px-2 text-xs text-button-default-fg hover:bg-button-default-hover-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-button-default-ring disabled:pointer-events-none disabled:text-button-disabled-fg aria-[current=page]:border-foreground/50 aria-[current=page]:bg-muted aria-[current=page]:font-semibold";

export function DataTable<T>({
  rows,
  columns,
  getRowId,
  caption,
  showCaption = false,
  search,
  pageSizes,
  initialSort = null,
  empty,
  rowClassName,
}: DataTableProps<T>) {
  const t = useTranslations("ui.dataTable");
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(initialSort);
  const [facets, setFacets] = useState<Record<string, string>>({});
  const [pageSize, setPageSize] = useState(pageSizes?.[0] ?? 0);
  const [page, setPage] = useState(1);

  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  const view = applyTableState(rows, columns, {
    query,
    sort,
    facets,
    pageSize,
    page,
  });
  const facetColumns = columns
    .filter((c) => c.facetValue)
    .map((c) => ({ column: c, options: facetOptions(rows, c) }));
  const hasToolbar =
    Boolean(search) || facetColumns.length > 0 || Boolean(pageSizes);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="data-table">
      {hasToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          {search ? (
            <div className="relative min-w-40 flex-1">
              <Search
                aria-hidden
                focusable={false}
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                id={searchId}
                type="search"
                value={query}
                placeholder={search.placeholder ?? t("search")}
                aria-label={search.placeholder ?? t("search")}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                className={cx(
                  controlClass,
                  "w-full pl-7 placeholder:text-input-placeholder",
                )}
              />
            </div>
          ) : null}
          {facetColumns.map(({ column, options }) => (
            <select
              key={column.id}
              aria-label={t("filterBy", { label: column.header })}
              value={facets[column.id] ?? ""}
              onChange={(e) => {
                setFacets((prev) => ({ ...prev, [column.id]: e.target.value }));
                setPage(1);
              }}
              className={controlClass}
            >
              <option value="">
                {t("facetAll", { label: column.header })}
              </option>
              {options.map((value) => (
                <option key={value} value={value}>
                  {column.facetLabel ? column.facetLabel(value) : value}
                </option>
              ))}
            </select>
          ))}
          {pageSizes ? (
            <label className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
              {t("rowsPerPage")}
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className={controlClass}
              >
                {pageSizes.map((size) => (
                  <option key={size} value={size}>
                    {size === 0 ? t("all") : size}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="relative w-full overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full caption-bottom text-sm">
          <caption
            className={
              showCaption ? "mt-3 text-xs text-muted-foreground" : "sr-only"
            }
          >
            {caption}
          </caption>
          <thead className="bg-card-header-bg">
            <tr className="border-b border-border">
              {columns.map((column) => {
                const active =
                  sort?.columnId === column.id ? sort.direction : null;
                const SortIcon =
                  active === "asc"
                    ? ArrowUp
                    : active === "desc"
                      ? ArrowDown
                      : ArrowUpDown;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      column.sortValue
                        ? active === "asc"
                          ? "ascending"
                          : active === "desc"
                            ? "descending"
                            : "none"
                        : undefined
                    }
                    className={cx(
                      "h-9 whitespace-nowrap px-3 align-middle text-xs font-medium text-card-header-fg",
                      column.align === "end" ? "text-right" : "text-left",
                    )}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSort((prev) => nextSort(prev, column.id));
                          setPage(1);
                        }}
                        className={cx(
                          "inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          column.align === "end" && "flex-row-reverse",
                        )}
                      >
                        {column.header}
                        <SortIcon
                          aria-hidden
                          focusable={false}
                          className={cx(
                            "size-3",
                            active
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {view.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  {t("noMatches")}
                </td>
              </tr>
            ) : (
              view.rows.map((row) => (
                <tr
                  key={getRowId(row)}
                  className={cx(
                    "border-b border-border/60 last:border-0 hover:bg-muted/50",
                    rowClassName?.(row),
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cx(
                        "px-3 py-2 align-middle",
                        column.align === "end" && "text-right tabular-nums",
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageSizes ? (
        <nav
          aria-label={t("pagination")}
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        >
          <span data-testid="data-table-range">
            {t("range", { from: view.from, to: view.to, total: view.total })}
          </span>
          <span className="ml-auto inline-flex items-center gap-1">
            <button
              type="button"
              aria-label={t("previousPage")}
              disabled={view.page <= 1}
              onClick={() => {
                setPage(view.page - 1);
              }}
              className={pagerButtonClass}
            >
              <ChevronLeft aria-hidden focusable={false} className="size-3.5" />
            </button>
            {pageList(view.page, view.pageCount).map((item, index) =>
              item === "gap" ? (
                // Gaps have no identity of their own; their position is stable within one render.
                <span key={`gap-${String(index)}`} aria-hidden className="px-1">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  aria-label={t("page", { page: item })}
                  aria-current={item === view.page ? "page" : undefined}
                  onClick={() => {
                    setPage(item);
                  }}
                  className={pagerButtonClass}
                >
                  {item}
                </button>
              ),
            )}
            <button
              type="button"
              aria-label={t("nextPage")}
              disabled={view.page >= view.pageCount}
              onClick={() => {
                setPage(view.page + 1);
              }}
              className={pagerButtonClass}
            >
              <ChevronRight
                aria-hidden
                focusable={false}
                className="size-3.5"
              />
            </button>
          </span>
        </nav>
      ) : null}
    </div>
  );
}
