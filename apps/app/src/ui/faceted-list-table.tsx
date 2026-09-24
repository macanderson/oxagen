"use client";
// A list table with the design's list tools (the mockup's `ltTable`,
// `ltBar` and `ltPager` in engine.js): a search box, a filter per small
// enumeration column, a rows-per-page select, sortable column headers, and a
// numbered pager under the table reading "1–10 of 75". The rows arrive whole,
// in the order the caller means them to be read, and every tool works over
// them in the browser; a header sorts on its first press, reverses on its
// second, and gives the caller's order back on its third.
//
// Each row is drawn by the caller (`node`, a `<tr>`), with the plain text the
// tools compare beside it, so a cell can hold a link or a badge and still be
// searched, filtered and sorted by what it says. The header keeps one row with
// no grouped cells, so a phone still turns the table into labelled cards
// (features/shell/card-tables.ts); the sort glyph is drawn by CSS, so it never
// becomes part of a card's label.
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ComponentProps, type ReactNode, useMemo, useState } from "react";
import { buttonSecondary } from "./control-styles";
import { headCell } from "./table";

export type ListColumn = {
  key: string;
  label: string;
  numeric?: boolean;
};

export type ListRow = {
  key: string;
  /** Each column's value as the tools compare it; a number sorts as one. */
  values: Readonly<Record<string, string | number | null>>;
  /** The drawn row: a `<tr>` with one cell per column, in column order. */
  node: ReactNode;
};

/** The rows-per-page choices; 0 is every row on one page. */
const PER_PAGE = [5, 10, 25, 50, 0] as const;

// The bar's controls share one skin and size to their content. `inputBase`
// is a form field (`block w-full`), and in this flex row it stretched the
// search and every select to a full line of its own, so the bar stacked into
// five rows. The search takes the room left over; each select is as wide as
// its longest option, with its own chevron in place of the browser's.
const control =
  "min-h-8 max-md:min-h-11 rounded-md border border-input-border bg-input-bg py-1.5 text-[13px] max-md:text-base text-input-fg " +
  "hover:border-input-border-hover focus-visible:border-input-border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring";
const search = `${control} min-w-0 flex-[1_1_14rem] px-3 placeholder:text-input-placeholder`;
const select = `${control} cursor-pointer appearance-none pl-3 pr-8`;

/** A select with the bar's chevron; the wrapper keeps it one flex item. */
function BarSelect(props: ComponentProps<"select">) {
  return (
    <span className="relative inline-flex shrink-0">
      <select {...props} className={select} />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}

type Sort = { key: string; dir: 1 | -1 } | null;

function compare(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  if (a === b) return 0;
  // A value nobody recorded sorts after every value, either way round.
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** The page numbers the pager draws: all of them to seven, else the ends and the neighbours. */
export function pageNumbers(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const shown: (number | "gap")[] = [1];
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pages - 1, page + 1);
  if (lo > 2) shown.push("gap");
  for (let n = lo; n <= hi; n++) shown.push(n);
  if (hi < pages - 1) shown.push("gap");
  shown.push(pages);
  return shown;
}

export function ListTable({
  label,
  columns,
  rows,
  filters = [],
  searchLabel,
  testId,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  columns: readonly ListColumn[];
  rows: readonly ListRow[];
  /** Keys of the columns that get a filter select, in the order they render. */
  filters?: readonly string[];
  /** The search box's placeholder and name; "Search this list" when omitted. */
  searchLabel?: string;
  testId?: string;
}) {
  const t = useTranslations("ui.list");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<Sort>(null);
  const [per, setPer] = useState<number>(10);
  const [page, setPage] = useState(1);

  const facets = useMemo(
    () =>
      filters.flatMap((key) => {
        const column = columns.find((c) => c.key === key);
        if (column === undefined) return [];
        const values = [
          ...new Set(
            rows.flatMap((row) => {
              const value = row.values[key];
              return value === null || value === undefined
                ? []
                : [String(value)];
            }),
          ),
        ].sort((a, b) => compare(a, b));
        return [{ key, label: column.label, values }];
      }),
    [filters, columns, rows],
  );

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = rows.filter((row) => {
      if (
        needle !== "" &&
        !Object.values(row.values).some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(needle),
        )
      ) {
        return false;
      }
      return Object.entries(picked).every(
        ([key, value]) => value === "" || String(row.values[key]) === value,
      );
    });
    if (sort === null) return matched;
    return matched
      .map((row, index) => ({ row, index }))
      .sort(
        (a, b) =>
          compare(a.row.values[sort.key], b.row.values[sort.key]) * sort.dir ||
          a.index - b.index,
      )
      .map(({ row }) => row);
  }, [rows, query, picked, sort]);

  const total = shown.length;
  const size = per === 0 ? Math.max(total, 1) : per;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages);
  const slice = shown.slice((current - 1) * size, current * size);
  const from = total === 0 ? 0 : (current - 1) * size + 1;
  const to = Math.min(total, current * size);

  const toggle = (key: string) => {
    setPage(1);
    setSort((was) =>
      was?.key !== key
        ? { key, dir: 1 }
        : was.dir === 1
          ? { key, dir: -1 }
          : null,
    );
  };

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col">
      <div
        data-list-tools=""
        className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5"
      >
        <input
          type="search"
          className={search}
          placeholder={searchLabel ?? t("search")}
          aria-label={searchLabel ?? t("search")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
        />
        {facets.map((facet) => (
          <BarSelect
            key={facet.key}
            data-filter={facet.key}
            aria-label={t("filterBy", { column: facet.label })}
            value={picked[facet.key] ?? ""}
            onChange={(event) => {
              setPicked((was) => ({ ...was, [facet.key]: event.target.value }));
              setPage(1);
            }}
          >
            <option value="">{t("all", { column: facet.label })}</option>
            {facet.values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </BarSelect>
        ))}
        <label className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          {t("rows")}
          <BarSelect
            data-rows=""
            aria-label={t("rows")}
            value={per}
            onChange={(event) => {
              setPer(Number(event.target.value));
              setPage(1);
            }}
          >
            {PER_PAGE.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t("allRows") : n}
              </option>
            ))}
          </BarSelect>
        </label>
      </div>
      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label={label}
          className="w-full min-w-[560px] border-collapse text-[13px]"
        >
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => {
                const dir = sort?.key === column.key ? sort.dir : 0;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      dir === 1
                        ? "ascending"
                        : dir === -1
                          ? "descending"
                          : "none"
                    }
                    className={`${headCell} ${column.numeric === true ? "text-right" : "text-left"}`}
                  >
                    <button
                      type="button"
                      data-sort={column.key}
                      onClick={() => {
                        toggle(column.key);
                      }}
                      className={`inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring after:font-normal after:opacity-70 ${dir === 1 ? "after:content-['↑']" : dir === -1 ? "after:content-['↓']" : "after:content-['↕']"}`}
                    >
                      {column.label}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl">
            {slice.length === 0 ? (
              <tr data-state="no-match">
                <td
                  colSpan={columns.length}
                  className="px-3 py-4 text-muted-foreground"
                >
                  {t("noMatch")}
                </td>
              </tr>
            ) : (
              slice.map((row) => row.node)
            )}
          </tbody>
        </table>
      </div>
      <nav
        aria-label={t("pager")}
        className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-[12px] text-muted-foreground"
      >
        <span className="font-mono" data-range="">
          {total === 0
            ? t("rangeEmpty")
            : t("range", {
                from: String(from),
                to: String(to),
                total: String(total),
              })}
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            data-touch-target=""
            className={`${buttonSecondary} min-h-7 px-2 py-0.5 text-[12px]`}
            aria-label={t("previous")}
            disabled={current <= 1}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            ‹
          </button>
          {pageNumbers(current, pages).map((n, index) =>
            n === "gap" ? (
              <span
                // Two gaps can sit in one pager; the index keeps them apart.
                key={`gap-${String(index)}`}
                aria-hidden="true"
                className="px-1"
              >
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                data-touch-target=""
                className={`${buttonSecondary} min-h-7 px-2 py-0.5 text-[12px] aria-[current=page]:border-gold aria-[current=page]:text-foreground`}
                aria-current={n === current ? "page" : undefined}
                aria-label={t("page", { page: String(n) })}
                onClick={() => {
                  setPage(n);
                }}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            data-touch-target=""
            className={`${buttonSecondary} min-h-7 px-2 py-0.5 text-[12px]`}
            aria-label={t("next")}
            disabled={current >= pages}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            ›
          </button>
        </span>
      </nav>
    </div>
  );
}
