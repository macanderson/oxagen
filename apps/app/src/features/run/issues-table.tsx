"use client";
// The Issues table's list controls (pages/run.md, Issues): the Status filter
// ("All (Status)", then open, closed, in progress and blocked), beside the
// shared list table's search. Its pager under the table holds the Rows
// select (5, 10, 25, 50, All).
// The rows arrive rendered from the server, each with the status GitHub read
// for it, so this island decides only which rows the filter keeps. A row
// whose status was not read is kept by "All" alone.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ListSelect } from "@/ui/list-select";
import { type ListColumn, ListTable, listSelect } from "@/ui/list-table";

/** The statuses the filter offers, in the order the design lists them. */
const STATUSES = ["open", "closed", "in_progress", "blocked"] as const;
type Status = (typeof STATUSES)[number];

export type IssueTableRow = {
  key: string;
  /** The status GitHub read for the issue; null when none was read. */
  status: Status | null;
  cells: readonly ReactNode[];
};

export function IssuesTable({
  label,
  columns,
  rows,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  columns: readonly ListColumn[];
  rows: readonly IssueTableRow[];
}) {
  const t = useTranslations("run.issues");
  const list = useTranslations("ui.listTable");
  const [status, setStatus] = useState<Status | "">("");
  const kept =
    status === "" ? rows : rows.filter((row) => row.status === status);
  return (
    <ListTable
      label={label}
      columns={columns}
      empty={t("noMatch")}
      rows={kept.map((row) => ({
        key: row.key,
        cells: row.cells,
        data: { "data-testid": "run-issue" },
      }))}
      filters={
        <ListSelect
          aria-label={t("statusFilter")}
          items={[
            { value: "", label: list("facetAll", { column: t("status") }) },
            ...STATUSES.map((value) => ({
              value,
              label: t(`state.${value}`),
            })),
          ]}
          value={status}
          onValue={(value) => {
            const next = STATUSES.find((s) => s === value);
            setStatus(next ?? "");
          }}
          size="sm"
          data-touch-target=""
          className={listSelect}
        />
      }
    />
  );
}
