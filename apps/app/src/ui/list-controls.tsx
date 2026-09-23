"use client";
// The four list controls every list in the mockup carries (engine.js
// `ltBar`, `ltPager`, `ltCards`): a search box, a sort or a column filter, a
// rows-per-page select, and a pager. The state is local to the list: a search
// narrows what is on screen and changes nothing it reads.
//
// Strings arrive as props, already translated by the caller, so the kit
// carries no catalogue of its own for a control whose words differ per list
// ("Search records", "Search this list").
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useId, useMemo, useState } from "react";

/** The mockup's rows-per-page choices. */
const PER_PAGE = [10, 25, 50] as const;

export type ListSort<T> = {
  value: string;
  label: string;
  /** Null keeps the list's own order. */
  compare: ((a: T, b: T) => number) | null;
};

export type ListFilter<T> = {
  key: string;
  /** The column the filter narrows, printed after "All · ". */
  label: string;
  options: readonly { value: string; label: string }[];
  get: (item: T) => string;
};

export type ListState<T> = {
  shown: T[];
  total: number;
  page: number;
  pages: number;
  from: number;
  to: number;
  query: string;
  setQuery: (next: string) => void;
  sort: string;
  setSort: (next: string) => void;
  filters: Readonly<Record<string, string>>;
  setFilter: (key: string, value: string) => void;
  perPage: number;
  setPerPage: (next: number) => void;
  setPage: (next: number) => void;
};

/** Search, filter, sort and page one in-memory list. */
export function useList<T>(
  items: readonly T[],
  options: {
    text: (item: T) => string;
    sorts?: readonly ListSort<T>[];
    filters?: readonly ListFilter<T>[];
  },
): ListState<T> {
  const [query, setQueryState] = useState("");
  const [sort, setSortState] = useState(options.sorts?.[0]?.value ?? "");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [perPage, setPerPageState] = useState<number>(PER_PAGE[0]);
  const [page, setPage] = useState(1);
  const { text, sorts, filters: facets } = options;

  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const kept = items.filter((item) => {
      if (needle !== "" && !text(item).toLowerCase().includes(needle))
        return false;
      return (facets ?? []).every((facet) => {
        const wanted = filters[facet.key];
        return (
          wanted === undefined || wanted === "" || facet.get(item) === wanted
        );
      });
    });
    const compare = sorts?.find((option) => option.value === sort)?.compare;
    return compare === null || compare === undefined
      ? kept
      : [...kept].sort(compare);
  }, [items, query, filters, sort, text, sorts, facets]);

  const total = matched.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(page, pages);
  const start = (current - 1) * perPage;
  const shown = matched.slice(start, start + perPage);
  return {
    shown,
    total,
    page: current,
    pages,
    from: total === 0 ? 0 : start + 1,
    to: start + shown.length,
    query,
    setQuery: (next) => {
      setQueryState(next);
      setPage(1);
    },
    sort,
    setSort: (next) => {
      setSortState(next);
      setPage(1);
    },
    filters,
    setFilter: (key, value) => {
      setFilters((previous) => ({ ...previous, [key]: value }));
      setPage(1);
    },
    perPage,
    setPerPage: (next) => {
      setPerPageState(next);
      setPage(1);
    },
    setPage,
  };
}

const select =
  "min-h-9 rounded-md border border-input-border bg-input-bg px-2 text-base text-input-fg focus-visible:outline-2 focus-visible:outline-input-ring sm:text-[13px]";

/** `.lt-bar`: search, then the filters or the sort, then Rows. */
export function ListBar<T>({
  list,
  searchLabel,
  sortLabel,
  sorts,
  filters,
  allLabel,
  rowsLabel,
}: {
  list: ListState<T>;
  searchLabel: string;
  /** "Sort", beside a select of `sorts`; omit for a list with no sort. */
  sortLabel?: string;
  sorts?: readonly ListSort<T>[];
  filters?: readonly ListFilter<T>[];
  /** Formats a filter's empty option: "All · Role". */
  allLabel?: (column: string) => string;
  rowsLabel: string;
}) {
  const id = useId();
  return (
    <div
      data-list-bar=""
      className="flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2.5 text-[12.5px] text-muted-foreground"
    >
      <input
        type="search"
        aria-label={searchLabel}
        placeholder={searchLabel}
        value={list.query}
        onChange={(event) => {
          list.setQuery(event.target.value);
        }}
        className={`${select} min-w-40 flex-1 px-2.5`}
      />
      {(filters ?? []).map((filter) => (
        <select
          key={filter.key}
          aria-label={allLabel?.(filter.label) ?? filter.label}
          value={list.filters[filter.key] ?? ""}
          onChange={(event) => {
            list.setFilter(filter.key, event.target.value);
          }}
          className={select}
        >
          <option value="">{allLabel?.(filter.label) ?? filter.label}</option>
          {filter.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ))}
      {sortLabel !== undefined && sorts !== undefined && sorts.length > 0 ? (
        <label htmlFor={`${id}-sort`} className="flex items-center gap-2">
          {sortLabel}
          <select
            id={`${id}-sort`}
            value={list.sort}
            onChange={(event) => {
              list.setSort(event.target.value);
            }}
            className={select}
          >
            {sorts.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label htmlFor={`${id}-rows`} className="flex items-center gap-2">
        {rowsLabel}
        <select
          id={`${id}-rows`}
          value={list.perPage}
          onChange={(event) => {
            list.setPerPage(Number(event.target.value));
          }}
          className={select}
        >
          {PER_PAGE.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** `.lt-pager`: the range on the left, previous, the page, next on the right. */
export function ListPager<T>({
  list,
  range,
  previousLabel,
  nextLabel,
}: {
  list: ListState<T>;
  /** "1–3 of 3", formatted by the caller. */
  range: (from: number, to: number, total: number) => string;
  previousLabel: string;
  nextLabel: string;
}) {
  const button =
    "grid min-h-7 min-w-7 place-items-center rounded-md border border-border px-2 text-[11.5px] text-muted-foreground disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11";
  return (
    <div
      data-list-pager=""
      className="flex items-center justify-between gap-3 px-3 py-2.5"
    >
      <span className="font-mono text-[11.5px] text-dim">
        {range(list.from, list.to, list.total)}
      </span>
      <span className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={previousLabel}
          disabled={list.page <= 1}
          onClick={() => {
            list.setPage(list.page - 1);
          }}
          className={button}
        >
          <ChevronLeft aria-hidden="true" className="size-3" />
        </button>
        <span
          aria-current="page"
          className={`${button} border-gold text-foreground`}
        >
          {list.page}
        </span>
        <button
          type="button"
          aria-label={nextLabel}
          disabled={list.page >= list.pages}
          onClick={() => {
            list.setPage(list.page + 1);
          }}
          className={button}
        >
          <ChevronRight aria-hidden="true" className="size-3" />
        </button>
      </span>
    </div>
  );
}
