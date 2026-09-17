"use client";

/**
 * use-list-controls.ts — shared client-side search + sort + pagination state
 * for list/table pages.
 *
 * Pair with `list-toolbar.tsx` (search + sort + export UI) and
 * `list-pagination.tsx` (Prev/Next). The hook owns state; the components are
 * pure props-in renderers, so any list page can wire the same three pieces
 * together without re-deriving filter/sort/paging logic per page.
 */

import * as React from "react";

/** A selectable sort option: `compare` is a standard `Array#sort` comparator. */
export interface ListSortOption<T> {
  id: string;
  label: string;
  compare(a: T, b: T): number;
}

export interface UseListControlsOptions<T> {
  /**
   * Row fields (or derived-string functions) searched against the query,
   * case-insensitively, as a substring match. A row matches if ANY key
   * matches.
   */
  searchKeys: (keyof T | ((row: T) => string))[];
  /** Available sort options. Pass `[]` for an unsortable list. */
  sortOptions: ListSortOption<T>[];
  /** Sort id applied on first render. Defaults to `sortOptions[0]?.id`. */
  defaultSortId?: string;
  /** Rows per page. Defaults to 12. */
  pageSize?: number;
}

export interface UseListControlsResult<T> {
  /** Current search query. */
  query: string;
  /** Updates the query and resets to page 1. */
  setQuery: (query: string) => void;
  /** Currently active sort id, or `undefined` when `sortOptions` is empty. */
  sortId: string | undefined;
  /** Updates the sort id and resets to page 1. */
  setSortId: (sortId: string) => void;
  /** Current 1-indexed page, clamped to `[1, pageCount]`. */
  page: number;
  /** Requests a page number; the returned `page` is clamped for you. */
  setPage: (page: number) => void;
  /** Total number of pages for the current filtered result set (>= 1). */
  pageCount: number;
  /** `rows.length` — the unfiltered total. */
  total: number;
  /** Number of rows matching the current search query. */
  filteredTotal: number;
  /** The rows for the current page (post filter + sort + paginate). */
  pageRows: T[];
  /** All rows matching the current query, sorted, unpaginated — use this for CSV export. */
  allFilteredRows: T[];
}

/**
 * `useListControls(rows, opts)` — case-insensitive substring search across
 * `searchKeys`, optional sort, and clamped pagination over a client-side
 * array of rows.
 *
 *   const controls = useListControls(agents, {
 *     searchKeys: ["name", (a) => a.owner.email],
 *     sortOptions: [
 *       { id: "name", label: "Name", compare: (a, b) => a.name.localeCompare(b.name) },
 *       { id: "recent", label: "Recently updated", compare: (a, b) => b.updatedAt - a.updatedAt },
 *     ],
 *     pageSize: 12,
 *   });
 *
 *   <ListToolbar query={controls.query} onQueryChange={controls.setQuery} ... />
 *   {controls.pageRows.map((row) => <AgentCard key={row.id} agent={row} />)}
 *   <ListPagination page={controls.page} pageCount={controls.pageCount} onPageChange={controls.setPage} />
 */
export function useListControls<T>(
  rows: T[],
  opts: UseListControlsOptions<T>,
): UseListControlsResult<T> {
  const { searchKeys, sortOptions, defaultSortId, pageSize = 12 } = opts;

  const [query, setQueryState] = React.useState("");
  const [sortId, setSortIdState] = React.useState<string | undefined>(
    defaultSortId ?? sortOptions[0]?.id,
  );
  const [rawPage, setRawPage] = React.useState(1);

  const setQuery = React.useCallback((next: string) => {
    setQueryState(next);
    setRawPage(1);
  }, []);

  const setSortId = React.useCallback((next: string) => {
    setSortIdState(next);
    setRawPage(1);
  }, []);

  const filteredRows = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      searchKeys.some((key) => {
        const value = typeof key === "function" ? key(row) : row[key];
        return String(value ?? "")
          .toLowerCase()
          .includes(q);
      }),
    );
  }, [rows, query, searchKeys]);

  const sortedRows = React.useMemo(() => {
    const activeSort = sortOptions.find((s) => s.id === sortId);
    if (!activeSort) return filteredRows;
    return [...filteredRows].sort(activeSort.compare);
  }, [filteredRows, sortOptions, sortId]);

  const total = rows.length;
  const filteredTotal = sortedRows.length;
  const pageCount = Math.max(1, Math.ceil(filteredTotal / pageSize));
  // Clamp defensively — covers the search/sort case (already reset above) AND
  // the case where `rows` itself shrinks out from under an unrelated page.
  const page = Math.min(Math.max(1, rawPage), pageCount);

  const setPage = React.useCallback((next: number) => {
    setRawPage(Math.max(1, Math.trunc(next)));
  }, []);

  const pageRows = React.useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, page, pageSize]);

  return {
    query,
    setQuery,
    sortId,
    setSortId,
    page,
    setPage,
    pageCount,
    total,
    filteredTotal,
    pageRows,
    allFilteredRows: sortedRows,
  };
}
