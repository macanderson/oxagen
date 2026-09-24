"use client";
// The list every Organization tab draws (mockup `.tw` under a `.panel-h`):
// a search box, the tab's select filters and a Rows size above the table, and
// a "1–10 of 51" pager below it. The rows arrive already rendered from the
// server section, each with the text the search box matches and the value it
// carries for each filter, so this island decides only which rows show. On a
// phone the shell turns the table into labelled cards
// (features/shell/card-tables.ts), which is why every column has a label.
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { cell, numericCell, Table } from "@/ui/table";

type ListColumn = { label: string; numeric?: boolean };

type ListFilter = {
  /** The key each row's `values` carries for this filter. */
  key: string;
  label: string;
  options: readonly { value: string; label: string }[];
  /**
   * Why this filter cannot narrow the rows yet: the record carries no value
   * for it. The design draws it, so it is shown, disabled, with the reason as
   * its description rather than offered as a filter that empties the table.
   */
  unrecorded?: string;
};

export type ListRow = {
  key: string;
  /** One node per column, in column order. */
  cells: readonly ReactNode[];
  /** What the search box matches, lowercased here. */
  search: string;
  /** This row's value for each filter, by the filter's key. */
  values?: Readonly<Record<string, string>>;
  /** A data attribute a test or a style keys the row on. */
  rowId?: string;
};

const PAGE_SIZES = [10, 25, 50] as const;

export function ListTable({
  label,
  columns,
  rows,
  filters = [],
  empty,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  columns: readonly ListColumn[];
  rows: readonly ListRow[];
  filters?: readonly ListFilter[];
  /** What the panel says when no row matches the search and the filters. */
  empty: string;
}) {
  const t = useTranslations("organization.list");
  const id = useId();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);

  const needle = query.trim().toLowerCase();
  const matching = rows.filter(
    (row) =>
      (needle === "" || row.search.toLowerCase().includes(needle)) &&
      filters.every((filter) => {
        const want = chosen[filter.key] ?? "";
        return want === "" || row.values?.[filter.key] === want;
      }),
  );
  const pages = Math.max(1, Math.ceil(matching.length / size));
  const current = Math.min(page, pages - 1);
  const shown = matching.slice(current * size, current * size + size);
  const from = matching.length === 0 ? 0 : current * size + 1;
  const to = current * size + shown.length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <label htmlFor={`${id}-search`} className="sr-only">
          {t("search")}
        </label>
        <input
          id={`${id}-search`}
          type="search"
          value={query}
          placeholder={t("search")}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          className={`${inputBase} min-w-[12rem] flex-1 max-md:text-base`}
        />
        {filters.map((filter) => (
          <span key={filter.key} className="contents">
            <label htmlFor={`${id}-${filter.key}`} className="sr-only">
              {filter.label}
            </label>
            <select
              id={`${id}-${filter.key}`}
              disabled={filter.unrecorded !== undefined}
              title={filter.unrecorded}
              aria-describedby={
                filter.unrecorded === undefined
                  ? undefined
                  : `${id}-${filter.key}-why`
              }
              data-not-recorded={
                filter.unrecorded === undefined ? undefined : ""
              }
              value={chosen[filter.key] ?? ""}
              onChange={(event) => {
                setChosen({ ...chosen, [filter.key]: event.target.value });
                setPage(0);
              }}
              className={`${inputBase} w-auto max-md:text-base`}
            >
              <option value="">{t("all", { filter: filter.label })}</option>
              {filter.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {filter.unrecorded === undefined ? null : (
              <span id={`${id}-${filter.key}-why`} className="sr-only">
                {filter.unrecorded}
              </span>
            )}
          </span>
        ))}
        <label htmlFor={`${id}-rows`} className="text-xs text-muted-foreground">
          {t("rows")}
        </label>
        <select
          id={`${id}-rows`}
          value={size}
          onChange={(event) => {
            setSize(Number(event.target.value));
            setPage(0);
          }}
          className={`${inputBase} w-auto max-md:text-base`}
        >
          {PAGE_SIZES.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-3.5 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <Table label={label} columns={columns}>
          {shown.map((row) => (
            <tr key={row.key} data-row={row.rowId}>
              {columns.map((column, index) => (
                <td
                  // A row's cells are positional, so the column names the cell.
                  key={column.label}
                  className={column.numeric === true ? numericCell : cell}
                >
                  {row.cells[index]}
                </td>
              ))}
            </tr>
          ))}
        </Table>
      )}
      <nav
        aria-label={t("pager", { list: label })}
        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs text-muted-foreground"
      >
        <span className="font-mono" data-testid="list-range">
          {t("range", { from, to, total: matching.length })}
        </span>
        {pages > 1 ? (
          <span className="flex gap-1.5">
            <button
              type="button"
              className={buttonSecondary}
              disabled={current === 0}
              onClick={() => {
                setPage(current - 1);
              }}
            >
              {t("previous")}
            </button>
            <button
              type="button"
              className={buttonSecondary}
              disabled={current >= pages - 1}
              onClick={() => {
                setPage(current + 1);
              }}
            >
              {t("next")}
            </button>
          </span>
        ) : null}
      </nav>
    </>
  );
}
