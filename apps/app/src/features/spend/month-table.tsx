"use client";
// The Month tab's table (#2962; v3 mockup `spdMonth`): one row per group, and a
// row that has runs opens under itself to its costliest ones. The server
// component renders every cell and every list of runs; this one holds only
// which row is open. The row's label is the toggle, a button that says whether
// its runs are showing, so the row opens from the keyboard as well as the
// pointer.
import { CaretRightIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { cell, headCell, numericCell } from "@/ui/table";

export type MonthTableRow = {
  key: string;
  label: ReactNode;
  runs: ReactNode;
  share: ReactNode;
  cost: ReactNode;
  /** The row's costliest runs; null for a row that lists none. */
  runList: ReactNode | null;
};

export function MonthTable({
  label,
  columns,
  rows,
  totalLabel,
  total,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  /** The column headings in order: the group, runs, share and cost. */
  columns: readonly [string, string, string, string];
  rows: readonly MonthTableRow[];
  totalLabel: string;
  total: ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [group, runs, share, cost] = columns;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table
        aria-label={label}
        className="w-full min-w-[560px] border-collapse text-[13px]"
      >
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={`${headCell} text-left`}>
              {group}
            </th>
            <th scope="col" className={`${headCell} text-right`}>
              {runs}
            </th>
            <th scope="col" className={`${headCell} text-left`}>
              {share}
            </th>
            <th scope="col" className={`${headCell} text-right`}>
              {cost}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, index) => {
            const isOpen = open === row.key;
            const listId = `spend-month-runs-${index}`;
            return [
              <tr
                key={row.key}
                data-key={row.key}
                className="transition-colors hover:bg-hl"
              >
                <th scope="row" className={`${cell} text-left font-normal`}>
                  {row.runList === null ? (
                    <span className="flex min-w-0 items-center gap-2 pl-6">
                      {row.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={listId}
                      onClick={() => setOpen(isOpen ? null : row.key)}
                      className="flex min-w-0 items-center gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <CaretRightIcon
                        aria-hidden="true"
                        className={`size-4 flex-none text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                      {row.label}
                    </button>
                  )}
                </th>
                <td className={numericCell}>{row.runs}</td>
                <td className={cell}>{row.share}</td>
                <td className={numericCell}>{row.cost}</td>
              </tr>,
              row.runList === null ? null : (
                <tr
                  key={`${row.key}:runs`}
                  id={listId}
                  hidden={!isOpen}
                  className="bg-hl/40"
                >
                  <td colSpan={4} className="px-3 py-2">
                    {row.runList}
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border font-semibold">
            <th scope="row" className={`${cell} text-left`}>
              {totalLabel}
            </th>
            <td className={cell} />
            <td className={cell} />
            <td className={numericCell}>{total}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
