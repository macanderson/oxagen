"use client";
// A list table with the controls every list in the design carries (the
// mockup's `ltTable`, engine.js, and the `.lt`, `.lp` and `th.sortable` rules
// in engine.css): a "Search this list" box, a Rows select (5, 10, 25, 50,
// All), a header that sorts its column on a click (ascending, descending, then
// the order the caller gave), and a "1–N of N ‹ 1 ›" pager under the table.
//
// The caller gives cells as nodes. Search and sort read the text each cell
// renders, measured from the DOM when the reader types or sorts, the way the
// mockup reads `textContent`, so a caller never writes a figure twice to make
// it searchable. A cell whose text leads with a number (money, counts) sorts
// as a number; an ISO date and anything else sorts as text. Every row stays
// in the DOM and a row outside the page is hidden, so the texts stay
// measurable and a row that holds a form keeps its state across a page turn.
//
// On a phone the shell turns the table into labelled cards
// (features/shell/card-tables.ts), reading each header's text. A hidden column
// (a link) names itself to assistive tech through aria-label and carries no
// text, so its card cell has no label.
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useRef, useState } from "react";
import { cell, headCell, numericCell } from "@/ui/table";

export type ListColumn = {
  label: string;
  numeric?: boolean;
  /** The header names the column to assistive tech and draws nothing (a link column). It does not sort. */
  hidden?: boolean;
  /** The cell's classes, when they differ from the column's default. */
  className?: string;
};

export type ListRow = {
  /** Stable across renders and unique in the list. */
  key: string;
  cells: readonly ReactNode[];
  /** `data-*` attributes the row carries. */
  data?: Readonly<Record<`data-${string}`, string>>;
  className?: string;
};

/** The Rows select's options; 0 is All. */
export const LIST_PAGE_SIZES = [5, 10, 25, 50, 0] as const;
const DEFAULT_PER = 10;

type Sort = { column: number; dir: 1 | -1 } | null;

/** The number a cell's text leads with, or null (the mockup's `ltNum`). */
export function leadingNumber(text: string): number | null {
  const s = text.trim();
  if (s === "" || /^\d{4}-\d{2}/.test(s)) return null;
  const c = s.replace(/[$,%×]/g, "");
  const m = /^[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i.exec(c);
  if (m === null) return null;
  let n = Number.parseFloat(m[0]);
  const unit = /^\s*([kKMB])(?![A-Za-z])/.exec(c.slice(m[0].length));
  if (unit !== null) {
    const u = unit[1];
    n *= u === "k" || u === "K" ? 1e3 : u === "M" ? 1e6 : 1e9;
  }
  return n;
}

function compare(a: string, b: string, numeric: boolean): number {
  if (numeric) {
    const x = leadingNumber(a);
    const y = leadingNumber(b);
    if (x !== null && y !== null && x !== y) return x - y;
    if (x === null && y !== null) return 1;
    if (y === null && x !== null) return -1;
  }
  return a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** The page numbers the pager shows, with an ellipsis on either side past seven pages. */
function pageList(
  page: number,
  pages: number,
): (number | "gap-before" | "gap-after")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const lo = Math.max(2, page - 1);
  const hi = Math.min(pages - 1, page + 1);
  const out: (number | "gap-before" | "gap-after")[] = [1];
  if (lo > 2) out.push("gap-before");
  for (let p = lo; p <= hi; p++) out.push(p);
  if (hi < pages - 1) out.push("gap-after");
  out.push(pages);
  return out;
}

const pagerButton =
  "inline-flex min-h-7 min-w-7 items-center justify-center rounded-[7px] border border-button-default-border bg-button-default-bg px-2 py-0.5 text-[12px] tabular-nums text-button-default-fg hover:bg-button-default-hover-bg disabled:cursor-default disabled:opacity-40 aria-[current=page]:border-gold aria-[current=page]:text-accent-text max-md:min-h-11 max-md:min-w-11";

const controlSelect =
  "rounded-lg border border-input-border bg-input-bg px-2 py-[5px] text-[12px] text-input-fg focus-visible:border-input-border-focus focus-visible:outline-none";

export function ListTable({
  label,
  columns,
  rows,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  columns: readonly ListColumn[];
  rows: readonly ListRow[];
}) {
  const t = useTranslations("ui.listTable");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(null);
  const [per, setPer] = useState<number>(DEFAULT_PER);
  const [page, setPage] = useState(1);
  const [texts, setTexts] = useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map(),
  );
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const searchId = useId();

  /** What each row renders, read from the DOM; called from an event, never during render. */
  const measure = (): ReadonlyMap<string, readonly string[]> => {
    const next = new Map<string, readonly string[]>();
    const tbody = bodyRef.current;
    if (tbody === null) return next;
    for (const tr of tbody.querySelectorAll<HTMLTableRowElement>(
      "tr[data-lt-key]",
    )) {
      next.set(
        tr.getAttribute("data-lt-key") ?? "",
        [...tr.cells].map((td) => td.textContent.replace(/\s+/g, " ").trim()),
      );
    }
    return next;
  };

  const textOf = (key: string) => texts.get(key) ?? [];
  const q = query.trim().toLowerCase();
  // A row that arrived after the last measure has no text yet: it stays in.
  let order = rows.filter((row) => {
    const text = texts.get(row.key);
    return (
      q === "" || text === undefined || text.join(" ").toLowerCase().includes(q)
    );
  });
  if (sort !== null) {
    const numeric = columns[sort.column]?.numeric === true;
    const index = new Map(rows.map((row, i) => [row.key, i]));
    order = [...order].sort(
      (a, b) =>
        compare(
          textOf(a.key)[sort.column] ?? "",
          textOf(b.key)[sort.column] ?? "",
          numeric,
        ) * sort.dir || (index.get(a.key) ?? 0) - (index.get(b.key) ?? 0),
    );
  }
  const total = order.length;
  const size = per === 0 ? Math.max(total, 1) : per;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages);
  const from = total === 0 ? 0 : (current - 1) * size + 1;
  const to = Math.min(total, current * size);
  const shown = new Map(
    order.slice(from - 1, to).map((row, i) => [row.key, i] as const),
  );
  const hiddenRows = rows.filter((row) => !order.includes(row));

  const toggle = (column: number) => {
    setTexts(measure());
    setSort((s) => {
      if (s === null || s.column !== column) return { column, dir: 1 };
      return s.dir === 1 ? { column, dir: -1 } : null;
    });
    setPage(1);
  };

  const renderRow = (row: ListRow, visibleIndex: number | null) => (
    <tr
      key={row.key}
      data-lt-key={row.key}
      {...row.data}
      style={visibleIndex === null ? { display: "none" } : undefined}
      className={[
        "transition-colors hover:bg-hl",
        visibleIndex !== null && visibleIndex > 0
          ? "border-t border-border"
          : "",
        row.className ?? "",
      ].join(" ")}
    >
      {columns.map((column, i) => (
        <td
          key={column.label}
          className={
            column.className ?? (column.numeric === true ? numericCell : cell)
          }
        >
          {row.cells[i]}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="flex min-w-0 flex-col">
      <div
        data-list-controls=""
        className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-[9px]"
      >
        <label htmlFor={searchId} className="sr-only">
          {t("search")}
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          placeholder={t("search")}
          onChange={(event) => {
            setTexts(measure());
            setQuery(event.currentTarget.value);
            setPage(1);
          }}
          data-touch-target=""
          className="min-w-[140px] flex-[1_1_200px] rounded-lg border border-input-border bg-input-bg px-2.5 py-1.5 text-[12.5px] text-input-fg placeholder:text-dim focus-visible:border-input-border-focus focus-visible:outline-none max-md:basis-full"
        />
        <label className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground max-md:ml-0">
          {t("rows")}
          <select
            value={per}
            onChange={(event) => {
              setPer(Number(event.currentTarget.value));
              setPage(1);
            }}
            data-touch-target=""
            className={controlSelect}
          >
            {LIST_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? t("all") : String(n)}
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
              {columns.map((column, i) => {
                const align =
                  column.numeric === true ? "text-right" : "text-left";
                if (column.hidden === true) {
                  return (
                    <th
                      key={column.label}
                      scope="col"
                      aria-label={column.label}
                      className={`${headCell} ${align}`}
                    />
                  );
                }
                const state =
                  sort?.column === i
                    ? sort.dir === 1
                      ? "ascending"
                      : "descending"
                    : "none";
                return (
                  <th
                    key={column.label}
                    scope="col"
                    aria-sort={state}
                    className={`${headCell} ${align}`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        toggle(i);
                      }}
                      data-sort={state}
                      className="inline-flex cursor-pointer select-none items-center uppercase tracking-[inherit] hover:text-muted-foreground data-[sort=ascending]:text-foreground data-[sort=descending]:text-foreground after:ml-[5px] after:text-[10px] after:text-rule after:content-['↕'] data-[sort=ascending]:after:text-accent-text data-[sort=ascending]:after:content-['↑'] data-[sort=descending]:after:text-accent-text data-[sort=descending]:after:content-['↓']"
                    >
                      {column.label}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {order.map((row) => renderRow(row, shown.get(row.key) ?? null))}
            {hiddenRows.map((row) => renderRow(row, null))}
            {total === 0 ? (
              <tr data-list-empty="">
                <td
                  colSpan={columns.length}
                  className="px-3 py-[18px] text-center text-dim"
                >
                  {t("noMatch")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <nav
        aria-label={t("pages", { label })}
        className="flex flex-wrap items-center gap-2 border-t border-border bg-card px-3 py-2 text-[11.5px] text-muted-foreground"
      >
        <span className="font-mono tabular-nums text-dim">
          {total === 0
            ? t("rangeNone")
            : t("range", {
                from: String(from),
                to: String(to),
                total: String(total),
              })}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-label={t("previous")}
            disabled={current <= 1}
            onClick={() => {
              setPage(current - 1);
            }}
            className={pagerButton}
          >
            ‹
          </button>
          {pageList(current, pages).map((p) =>
            typeof p === "string" ? (
              <span key={p} className="px-1 text-dim">
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                aria-current={p === current ? "page" : undefined}
                onClick={() => {
                  setPage(p);
                }}
                className={pagerButton}
              >
                {p}
              </button>
            ),
          )}
          <button
            type="button"
            aria-label={t("next")}
            disabled={current >= pages}
            onClick={() => {
              setPage(current + 1);
            }}
            className={pagerButton}
          >
            ›
          </button>
        </span>
      </nav>
    </div>
  );
}
