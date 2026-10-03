"use client";
// A list table with the design's list tools (the mockup's `ltTable`,
// `ltBar` and `ltPager` in engine.js): a search box and a filter per small
// enumeration column above the table, sortable column headers, and under the
// table the pager every list draws (ui/pagination): Rows and the range,
// "1–10 of 75", on the left, Previous and Next on the right. The rows arrive
// whole, in the order the caller means them to be read, and every tool works
// over them in the browser; a header sorts on its first press, reverses on
// its second, and gives the caller's order back on its third.
//
// Each row is drawn by the caller (`node`, a `<tr>`), with the plain text the
// tools compare beside it, so a cell can hold a link or a badge and still be
// searched, filtered and sorted by what it says. The header keeps one row with
// no grouped cells, so a phone still turns the table into labelled cards
// (features/shell/card-tables.ts); the sort glyph is drawn by CSS, so it never
// becomes part of a card's label.
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import { ListSelect } from "./list-select";
import { RowsPager } from "./pagination";
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
// five rows. The search takes the room left over. Each filter is the app's
// Select, as wide as the choice it shows, so its list opens on the
// translucent menu surface. It keeps the bar's height and never shrinks.
const control =
  "min-h-8 max-md:min-h-11 rounded-4xl border border-input-border bg-input-bg py-1.5 text-base max-md:text-input-touch text-input-fg " +
  "hover:border-input-border-hover focus-visible:border-input-border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-input-ring";
const search = `${control} min-w-0 grow basis-56 px-3 placeholder:text-input-placeholder`;
const filter = "shrink-0 max-md:min-h-11 max-md:text-input-touch";

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
              // An empty value would repeat the All choice, whose value is "".
              return value === null || value === undefined || value === ""
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
          <ListSelect
            key={facet.key}
            size="sm"
            className={filter}
            aria-label={t("filterBy", { column: facet.label })}
            items={[
              { value: "", label: t("all", { column: facet.label }) },
              ...facet.values.map((value) => ({ value, label: value })),
            ]}
            value={picked[facet.key] ?? ""}
            onValue={(next) => {
              setPicked((was) => ({ ...was, [facet.key]: next }));
              setPage(1);
            }}
          />
        ))}
      </div>
      <div className="min-w-0 overflow-x-auto">
        <table
          aria-label={label}
          className="w-full min-w-140 border-collapse text-sm"
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
                      className={`inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring after:font-normal after:opacity-70 ${dir === 1 ? "after:content-(--glyph-sort-asc)" : dir === -1 ? "after:content-(--glyph-sort-desc)" : "after:content-(--glyph-sort)"}`}
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
      <RowsPager
        className="border-t border-border px-4"
        label={t("pager")}
        rowsLabel={t("rows")}
        perPage={per}
        sizes={PER_PAGE}
        onPerPage={(size) => {
          setPer(size);
          setPage(1);
        }}
        sizeLabel={(size) => (size === 0 ? t("allRows") : String(size))}
        range={
          total === 0
            ? t("rangeEmpty")
            : t("range", {
                from: String(from),
                to: String(to),
                total: String(total),
              })
        }
        previousLabel={t("previous")}
        nextLabel={t("next")}
        previous={
          current <= 1
            ? null
            : () => {
                setPage(current - 1);
              }
        }
        next={
          current >= pages
            ? null
            : () => {
                setPage(current + 1);
              }
        }
      />
    </div>
  );
}
