// The list behaviour behind <DataTable>, as pure functions: search, facet
// filters, sort and paging (the mockup's listify(), plan §5 B1 L2). Kept out of
// the component so each rule is tested without a DOM.

/** A value a column sorts by. Money sorts as a bigint of micros, never a float. */
export type SortValue = string | number | bigint | null | undefined;
export type SortDirection = "asc" | "desc";
export type SortState = { columnId: string; direction: SortDirection } | null;

export type ColumnModel<T> = {
  id: string;
  sortValue?: ((row: T) => SortValue) | undefined;
  searchValue?: ((row: T) => string) | undefined;
  facetValue?: ((row: T) => string | null | undefined) | undefined;
};

export type TableState = {
  query: string;
  sort: SortState;
  /** Column id → the one value that column is filtered to. */
  facets: Readonly<Record<string, string>>;
  /** Rows per page; 0 shows every row. */
  pageSize: number;
  /** 1-based. Clamped to the pages that exist. */
  page: number;
};

export type TableView<T> = {
  rows: T[];
  total: number;
  page: number;
  pageCount: number;
  /** 1-based index of the first row shown; 0 when nothing matches. */
  from: number;
  to: number;
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Ascending order with empty values last; numbers and bigints compare exactly, strings naturally. */
export function compareSortValues(a: SortValue, b: SortValue): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  if (typeof a === "string" || typeof b === "string")
    return collator.compare(String(a), String(b));
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Click cycle on a header: ascending, then descending, then unsorted. */
export function nextSort(current: SortState, columnId: string): SortState {
  if (current?.columnId !== columnId) return { columnId, direction: "asc" };
  return current.direction === "asc" ? { columnId, direction: "desc" } : null;
}

/** Distinct facet values of a column, in natural order. */
export function facetOptions<T>(
  rows: readonly T[],
  column: ColumnModel<T>,
): string[] {
  const read = column.facetValue;
  if (!read) return [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = read(row);
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => collator.compare(a, b));
}

function rowSearchText<T>(row: T, columns: readonly ColumnModel<T>[]): string {
  const parts: string[] = [];
  for (const column of columns) {
    if (column.searchValue) parts.push(column.searchValue(row));
    else if (column.facetValue) parts.push(column.facetValue(row) ?? "");
    else if (column.sortValue) {
      const value = column.sortValue(row);
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join(" ").toLowerCase();
}

/** Apply search, facets, sort and paging, in that order. The input is never mutated. */
export function applyTableState<T>(
  rows: readonly T[],
  columns: readonly ColumnModel<T>[],
  state: TableState,
): TableView<T> {
  const query = state.query.trim().toLowerCase();
  const facetEntries = Object.entries(state.facets).filter(([, v]) => v);
  const byId = new Map(columns.map((c) => [c.id, c]));

  const indexed = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      if (query && !rowSearchText(row, columns).includes(query)) return false;
      for (const [columnId, value] of facetEntries) {
        const read = byId.get(columnId)?.facetValue;
        if (read && read(row) !== value) return false;
      }
      return true;
    });

  const sortColumn = state.sort ? byId.get(state.sort.columnId) : undefined;
  const readSort = sortColumn?.sortValue;
  if (state.sort && readSort) {
    const sign = state.sort.direction === "asc" ? 1 : -1;
    indexed.sort((a, b) => {
      const va = readSort(a.row);
      const vb = readSort(b.row);
      const aEmpty = va === null || va === undefined || va === "";
      const bEmpty = vb === null || vb === undefined || vb === "";
      // Empty values stay last in both directions.
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      return compareSortValues(va, vb) * sign || a.index - b.index;
    });
  }

  const total = indexed.length;
  const size = state.pageSize > 0 ? state.pageSize : Math.max(total, 1);
  const pageCount = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(1, state.page), pageCount);
  const start = (page - 1) * size;
  const shown = indexed.slice(start, start + size).map(({ row }) => row);
  return {
    rows: shown,
    total,
    page,
    pageCount,
    from: total === 0 ? 0 : start + 1,
    to: start + shown.length,
  };
}

/** Page buttons: every page up to seven, otherwise first, last, the neighbours and gaps. */
export function pageList(page: number, pageCount: number): (number | "gap")[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const items: (number | "gap")[] = [1];
  const low = Math.max(2, page - 1);
  const high = Math.min(pageCount - 1, page + 1);
  if (low > 2) items.push("gap");
  for (let p = low; p <= high; p++) items.push(p);
  if (high < pageCount - 1) items.push("gap");
  items.push(pageCount);
  return items;
}
