"use client";
// The four list controls every list in the mockup carries (engine.js
// `ltBar`, `ltPager`, `ltCards`): a search box, a sort or a column filter, and
// under the rows a pager that holds the rows-per-page select (ui/pagination).
// The state is local to the list: a search narrows what is on screen and
// changes nothing it reads. A filter and the sort are the app's Select, so
// their lists open on the translucent menu surface, as the mockup draws them.
//
// Strings arrive as props, already translated by the caller, so the kit
// carries no catalogue of its own for a control whose words differ per list
// ("Search records", "Search this list").
import { useId, useMemo, useState } from "react";
import { RowsPager } from "@/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

/** The rows-per-page choices, as shadcn's pagination example offers them. */
const PER_PAGE = [10, 25, 50, 100] as const;
const DEFAULT_PER_PAGE = 25;

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
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState(options.sorts?.[0]?.value ?? "");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [perPage, setPerPage] = useState<number>(DEFAULT_PER_PAGE);
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
      setQuery(next);
      setPage(1);
    },
    sort,
    setSort: (next) => {
      setSort(next);
      setPage(1);
    },
    filters,
    setFilter: (key, value) => {
      setFilters((previous) => ({ ...previous, [key]: value }));
      setPage(1);
    },
    perPage,
    setPerPage: (next) => {
      setPerPage(next);
      setPage(1);
    },
    setPage,
  };
}

const searchBox =
  "min-h-9 min-w-40 flex-1 rounded-md border border-input-border bg-input-bg px-2.5 text-base text-input-fg focus-visible:outline-2 focus-visible:outline-input-ring sm:text-[13px]";

/** One select in the bar: a trigger showing the chosen label, and its list. */
function BarSelect({
  items,
  value,
  onValue,
  ...trigger
}: {
  items: readonly { value: string; label: string }[];
  value: string;
  onValue: (next: string) => void;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onValue(next);
      }}
    >
      <SelectTrigger {...trigger}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** `.lt-bar`: search, then the filters or the sort. */
export function ListBar<T>({
  list,
  searchLabel,
  sortLabel,
  sorts,
  filters,
  allLabel,
}: {
  list: ListState<T>;
  searchLabel: string;
  /** "Sort", beside a select of `sorts`; omit for a list with no sort. */
  sortLabel?: string;
  sorts?: readonly ListSort<T>[];
  filters?: readonly ListFilter<T>[];
  /** Formats a filter's empty option: "All · Role". */
  allLabel?: (column: string) => string;
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
        className={searchBox}
      />
      {(filters ?? []).map((filter) => {
        const all = allLabel?.(filter.label) ?? filter.label;
        return (
          <BarSelect
            key={filter.key}
            aria-label={all}
            items={[{ value: "", label: all }, ...filter.options]}
            value={list.filters[filter.key] ?? ""}
            onValue={(next) => {
              list.setFilter(filter.key, next);
            }}
          />
        );
      })}
      {sortLabel !== undefined && sorts !== undefined && sorts.length > 0 ? (
        <span className="flex items-center gap-2">
          <span id={`${id}-sort`}>{sortLabel}</span>
          <BarSelect
            aria-labelledby={`${id}-sort`}
            items={sorts.map((sort) => ({
              value: sort.value,
              label: sort.label,
            }))}
            value={list.sort}
            onValue={list.setSort}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * `.lt-pager`: Rows per page and the range on the left, previous and next on
 * the right. Changing the rows goes back to page 1 (`useList`).
 */
export function ListPager<T>({
  list,
  label,
  rowsLabel,
  range,
  previousLabel,
  nextLabel,
}: {
  list: ListState<T>;
  /** The pager's name: "Pages". */
  label: string;
  /** "Rows per page". */
  rowsLabel: string;
  /** "1–3 of 3", formatted by the caller. */
  range: (from: number, to: number, total: number) => string;
  previousLabel: string;
  nextLabel: string;
}) {
  return (
    <RowsPager
      label={label}
      rowsLabel={rowsLabel}
      perPage={list.perPage}
      sizes={PER_PAGE}
      onPerPage={list.setPerPage}
      range={range(list.from, list.to, list.total)}
      previousLabel={previousLabel}
      nextLabel={nextLabel}
      previous={
        list.page <= 1
          ? null
          : () => {
              list.setPage(list.page - 1);
            }
      }
      next={
        list.page >= list.pages
          ? null
          : () => {
              list.setPage(list.page + 1);
            }
      }
    />
  );
}
