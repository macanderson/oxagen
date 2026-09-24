"use client";
// A list table with the design's list controls (mockup engine `ltTable()`):
// a search box, a filter per small enumeration column, Rows, a pager under
// the table, and a sort on every named header.
//
// The rows arrive already rendered, so a server page keeps its links, its
// not-recorded values and its translations. The controls read what each cell
// shows from the DOM after mount, as the mockup does, so the search, the
// filters and the sort work over the words a person sees and a caller never
// states a cell's text twice. Rows off the page stay in the DOM with `hidden`,
// which is what lets their text be read. Before that read the list shows its
// first page unfiltered, the same markup the server rendered.
//
// A column earns a filter by the design's rule (`ltFacets`): at least four
// rows, two to eight distinct values of 28 characters or fewer, not one per
// row. Status-like columns come first, then the one with fewer values, three
// at most. A column whose every row reads "not recorded" has one value and
// offers no filter.
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { cell, headCell, numericCell } from "@/ui/table";

export type ListColumn = {
  /** Stable across locales: facets are ranked by it, not by the label. */
  key: string;
  label: string;
  numeric?: boolean;
  /** Classes added to this column's body cells. */
  cellClassName?: string;
  /** A `data-testid` for this column's body cells. */
  cellTestId?: string;
};

export type ListRow = {
  key: string;
  /** One rendered cell per column. */
  cells: readonly ReactNode[];
  /** Attributes for the row itself: a test id, data attributes, classes. */
  props?: {
    className?: string;
    "data-testid"?: string;
    [data: `data-${string}`]: string | undefined;
  };
};

/** The page sizes Rows offers; `0` is All. */
const PAGE_SIZES = [5, 10, 25, 50, 0] as const;
const DEFAULT_PAGE_SIZE = 10;
const MIN_FACET_ROWS = 4;
const MAX_FACET_VALUES = 8;
const MAX_FACET_VALUE_LENGTH = 28;
const MAX_FACETS = 3;
/** `LT_FACET` in the mockup's engine, matched against the column key. */
const STATUS_LIKE =
  /status|state|tier|kind|role|risk|severity|result|health|effect|mode|side|level|verdict|decision|origin|scope|period|basis|algorithm|trend|position|governance/i;

type Sort = { index: number; dir: "ascending" | "descending" };

/** `ltNum`: the leading number a cell shows, or null for a word or a date. */
export function leadingNumber(text: string): number | null {
  const value = text.trim();
  if (value === "" || /^\d{4}-\d{2}/.test(value)) return null;
  const match = value.replace(/[$,%×]/g, "").match(/^[-+]?\d*\.?\d+/);
  return match === null ? null : Number.parseFloat(match[0]);
}

function compareCells(a: string, b: string, numeric: boolean): number {
  if (numeric) {
    const x = leadingNumber(a);
    const y = leadingNumber(b);
    if (x !== null && y !== null && x !== y) return x - y;
    if (x === null && y !== null) return 1;
    if (x !== null && y === null) return -1;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** The facets the design's rule offers over what the cells show. */
export function facetsOf(
  columns: readonly ListColumn[],
  texts: readonly (readonly string[])[],
): { index: number; values: string[] }[] {
  if (texts.length < MIN_FACET_ROWS) return [];
  return columns
    .flatMap((column, index) => {
      if (column.numeric === true || column.label === "") return [];
      const values = [
        ...new Set(texts.map((row) => row[index] ?? "").filter((v) => v)),
      ].sort((a, b) => a.localeCompare(b));
      const enumeration =
        values.length >= 2 &&
        values.length <= MAX_FACET_VALUES &&
        values.length < texts.length &&
        values.every((value) => value.length <= MAX_FACET_VALUE_LENGTH);
      return enumeration ? [{ index, values }] : [];
    })
    .sort(
      (a, b) =>
        Number(!STATUS_LIKE.test(columns[a.index]?.key ?? "")) -
          Number(!STATUS_LIKE.test(columns[b.index]?.key ?? "")) ||
        a.values.length - b.values.length,
    )
    .slice(0, MAX_FACETS);
}

function cellText(node: Element | undefined): string {
  return node?.textContent.replace(/\s+/g, " ").trim() ?? "";
}

export function ListTable({
  label,
  columns,
  rows,
  testId,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  columns: readonly ListColumn[];
  rows: readonly ListRow[];
  testId?: string;
}) {
  const t = useTranslations("ui.list");
  const locale = useLocale();
  const body = useRef<HTMLTableSectionElement>(null);
  const [texts, setTexts] = useState<Map<string, string[]> | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<number, string>>({});
  const [sort, setSort] = useState<Sort | null>(null);
  const [size, setSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);

  // Read what every row shows once the rows are in the DOM, and again when
  // the caller hands different rows.
  useEffect(() => {
    const read = new Map<string, string[]>();
    for (const tr of body.current?.rows ?? []) {
      const key = tr.getAttribute("data-list-row");
      if (key !== null) read.set(key, [...tr.cells].map(cellText));
    }
    setTexts(read);
  }, [rows]);

  const offered = useMemo(
    () =>
      texts === null
        ? []
        : facetsOf(
            columns,
            rows.map((row) => texts.get(row.key) ?? []),
          ),
    [columns, rows, texts],
  );

  const visible = useMemo(() => {
    if (texts === null) return rows;
    const needle = query.trim().toLowerCase();
    const textOf = (row: ListRow) => texts.get(row.key) ?? [];
    const filtered = rows.filter((row) => {
      const cells = textOf(row);
      if (needle !== "" && !cells.join(" ").toLowerCase().includes(needle))
        return false;
      return offered.every(
        ({ index }) =>
          (filters[index] ?? "") === "" || cells[index] === filters[index],
      );
    });
    if (sort === null) return filtered;
    const numeric = columns[sort.index]?.numeric === true;
    const sign = sort.dir === "ascending" ? 1 : -1;
    return filtered
      .map((row, order) => ({ row, order }))
      .sort(
        (a, b) =>
          sign *
            compareCells(
              textOf(a.row)[sort.index] ?? "",
              textOf(b.row)[sort.index] ?? "",
              numeric,
            ) || a.order - b.order,
      )
      .map(({ row }) => row);
  }, [rows, texts, query, offered, filters, sort, columns]);

  const pages = size === 0 ? 1 : Math.max(1, Math.ceil(visible.length / size));
  const current = Math.min(page, pages - 1);
  const shown = new Set(
    (size === 0
      ? visible
      : visible.slice(current * size, (current + 1) * size)
    ).map((row) => row.key),
  );
  const from = visible.length === 0 ? 0 : size === 0 ? 1 : current * size + 1;
  const to =
    size === 0
      ? visible.length
      : Math.min(visible.length, (current + 1) * size);
  // Every row stays mounted, the visible ones first in their order, so the
  // text read above always has the whole list.
  const ordered = [...visible, ...rows.filter((row) => !visible.includes(row))];

  return (
    <div data-testid={testId} className="flex min-w-0 flex-col">
      <div
        data-testid="list-controls"
        className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-[9px]"
      >
        <input
          type="search"
          value={query}
          aria-label={t("search")}
          placeholder={t("search")}
          data-touch-target=""
          className={`${inputBase} min-w-36 flex-[1_1_200px] max-md:basis-full`}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
        {offered.map(({ index, values }) => {
          const column = columns[index]?.label ?? "";
          return (
            <select
              key={columns[index]?.key ?? index}
              aria-label={t("facetLabel", { column })}
              value={filters[index] ?? ""}
              data-touch-target=""
              className={`${inputBase} w-auto max-w-56`}
              onChange={(event) => {
                setFilters((was) => ({ ...was, [index]: event.target.value }));
                setPage(0);
              }}
            >
              <option value="">{t("facetAll", { column })}</option>
              {values.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          );
        })}
        <label className="ml-auto flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground max-md:ml-0">
          {t("rows")}
          <select
            value={size}
            data-touch-target=""
            className={`${inputBase} w-auto`}
            onChange={(event) => {
              setSize(Number(event.target.value));
              setPage(0);
            }}
          >
            {PAGE_SIZES.map((option) => (
              <option key={option} value={option}>
                {option === 0 ? t("all") : formatCount(option, locale)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label={label}
          className="w-full min-w-[560px] border-collapse text-[13px]"
        >
          <thead>
            <tr className="border-b border-border">
              {columns.map((column, index) => {
                const sorted = sort?.index === index ? sort.dir : undefined;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sorted ?? "none"}
                    className={`${headCell} ${column.numeric === true ? "text-right" : "text-left"}`}
                  >
                    {/* The header keeps its column's name; the sort state
                        is the header's `aria-sort`. */}
                    <button
                      type="button"
                      title={t("sortBy", { column: column.label })}
                      className="inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => {
                        setSort(
                          sorted === "ascending"
                            ? { index, dir: "descending" }
                            : sorted === "descending"
                              ? null
                              : { index, dir: "ascending" },
                        );
                        setPage(0);
                      }}
                    >
                      {column.label}
                      {sorted === "ascending" ? (
                        <ArrowUp
                          aria-hidden="true"
                          className="size-3 text-gold"
                        />
                      ) : sorted === "descending" ? (
                        <ArrowDown
                          aria-hidden="true"
                          className="size-3 text-gold"
                        />
                      ) : (
                        <ArrowUpDown
                          aria-hidden="true"
                          className="size-3 opacity-50"
                        />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody
            ref={body}
            className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl"
          >
            {ordered.map((row) => (
              <tr
                key={row.key}
                {...row.props}
                data-list-row={row.key}
                hidden={!shown.has(row.key)}
              >
                {columns.map((column, index) => (
                  <td
                    key={column.key}
                    data-testid={column.cellTestId}
                    className={`${column.numeric === true ? numericCell : cell} ${column.cellClassName ?? ""}`}
                  >
                    {row.cells[index]}
                  </td>
                ))}
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr data-testid="list-no-match">
                <td
                  colSpan={columns.length}
                  className={`${cell} py-[18px] text-center text-dim`}
                >
                  {t("noMatch")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div
        data-testid="list-pager"
        className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-[11.5px] text-muted-foreground"
      >
        <span className={`${mono} tabular-nums text-dim`}>
          {t("range", {
            from: formatCount(from, locale),
            to: formatCount(to, locale),
            total: formatCount(visible.length, locale),
          })}
        </span>
        <nav aria-label={t("pager")} className="ml-auto flex flex-wrap gap-1">
          <button
            type="button"
            aria-label={t("previous")}
            disabled={current === 0}
            data-touch-target=""
            className={`${buttonSecondary} min-h-7 min-w-7 px-2 disabled:opacity-40`}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            ‹
          </button>
          {Array.from({ length: pages }, (_, index) => (
            <button
              key={index}
              type="button"
              aria-label={t("page", { page: index + 1 })}
              aria-current={index === current ? "page" : undefined}
              data-touch-target=""
              className={`${buttonSecondary} min-h-7 min-w-7 px-2 tabular-nums aria-[current=page]:border-gold aria-[current=page]:text-gold`}
              onClick={() => {
                setPage(index);
              }}
            >
              {formatCount(index + 1, locale)}
            </button>
          ))}
          <button
            type="button"
            aria-label={t("next")}
            disabled={current === pages - 1}
            data-touch-target=""
            className={`${buttonSecondary} min-h-7 min-w-7 px-2 disabled:opacity-40`}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            ›
          </button>
        </nav>
      </div>
    </div>
  );
}
