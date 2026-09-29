"use client";
// The list every Organization tab draws (mockup `ltTable` under a `.panel-h`):
// the shared list table (`@/ui/list-table`: search, sortable headers, and a
// pager with Rows 5 to All) with this lane's select filters beside the
// search box, "All · Status" and the like. The rows arrive already rendered
// from the server section, each with the value it carries for each filter, so
// this island decides only which rows the filters keep and hands those to the
// shared table. On a phone the shell turns the table into labelled cards
// (features/shell/card-tables.ts), which is why every shown column has a label.
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { ListSelect } from "@/ui/list-select";
import {
  type ListColumn,
  ListTable as SharedListTable,
  listSelect,
} from "@/ui/list-table";

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
  /** This row's value for each filter, by the filter's key. */
  values?: Readonly<Record<string, string>>;
  /** A data attribute a test or a style keys the row on. */
  rowId?: string;
};

export function ListTable({
  label,
  columns,
  rows,
  filters = [],
  empty,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  /** A column with `hidden` (the row actions) has an empty header, as the design draws it. */
  columns: readonly ListColumn[];
  rows: readonly ListRow[];
  filters?: readonly ListFilter[];
  /** What the panel says when no row matches the search and the filters. */
  empty: string;
}) {
  const t = useTranslations("organization.list");
  const id = useId();
  const [chosen, setChosen] = useState<Record<string, string>>({});

  const kept = rows.filter((row) =>
    filters.every((filter) => {
      const want = chosen[filter.key] ?? "";
      return want === "" || row.values?.[filter.key] === want;
    }),
  );

  return (
    <SharedListTable
      label={label}
      columns={columns}
      empty={empty}
      rows={kept.map((row) => ({
        key: row.key,
        cells: row.cells,
        ...(row.rowId === undefined ? {} : { data: { "data-row": row.rowId } }),
      }))}
      filters={filters.map((filter) => (
        <span key={filter.key} className="contents">
          <ListSelect
            aria-label={filter.label}
            items={[
              { value: "", label: t("all", { filter: filter.label }) },
              ...filter.options,
            ]}
            value={chosen[filter.key] ?? ""}
            onValue={(value) => {
              setChosen({ ...chosen, [filter.key]: value });
            }}
            disabled={filter.unrecorded !== undefined}
            title={filter.unrecorded}
            aria-describedby={
              filter.unrecorded === undefined
                ? undefined
                : `${id}-${filter.key}-why`
            }
            data-not-recorded={filter.unrecorded === undefined ? undefined : ""}
            size="sm"
            data-touch-target=""
            className={`${listSelect} disabled:opacity-60`}
          />
          {filter.unrecorded === undefined ? null : (
            <span id={`${id}-${filter.key}-why`} className="sr-only">
              {filter.unrecorded}
            </span>
          )}
        </span>
      ))}
    />
  );
}
