"use client";
// The Month tab's table (#2962; v3 mockup `spdMonth`): one row per group, and a
// row that has runs opens under itself to its costliest ones. The server
// component renders every cell and every list of runs; this one holds only
// which row is open. A caret button beside the row's label is the toggle, and
// says whether its runs are showing, so the row opens from the keyboard as
// well as the pointer. The label stays apart from the button because it links
// to the group's drill where the group has one. On the agent grouping a fifth
// column holds each agent's spend per merged PR (F26). Its figure is a second
// toggle for the same row, since the open row lists the runs behind it.
import { CaretRightIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { cell, headCell, numericCell } from "@/ui/table";

export type MonthTableRow = {
  key: string;
  /** The group's name, a link to its drill where the group has one. */
  label: ReactNode;
  /** The caret's accessible name, already translated. */
  toggleLabel: string;
  runs: ReactNode;
  share: ReactNode;
  cost: ReactNode;
  /** The row's costliest runs; null for a row that lists none. */
  runList: ReactNode | null;
  /**
   * The extra column's cell, when the table has one. With `toggleLabel`, the
   * cell opens the row's runs like the caret does.
   */
  extra?: { content: ReactNode; toggleLabel: string | null };
};

/**
 * The fifth column's cell. A figure with runs behind it is a button that opens
 * the row, and its toggle label rides along for a screen reader, so the
 * figure stays in the button's name.
 */
function ExtraCell({
  extra,
  opens,
  isOpen,
  listId,
  onToggle,
}: {
  extra: MonthTableRow["extra"];
  opens: boolean;
  isOpen: boolean;
  listId: string;
  onToggle: () => void;
}) {
  if (extra === undefined) return null;
  if (extra.toggleLabel === null || !opens) return extra.content;
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      aria-controls={listId}
      onClick={onToggle}
      className="ml-auto flex flex-col items-end rounded-sm text-right hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {extra.content}
      <span className="sr-only">{extra.toggleLabel}</span>
    </button>
  );
}

export function MonthTable({
  label,
  columns,
  rows,
  totalLabel,
  total,
  extraColumn,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  /** The column headings in order: the group, runs, share and cost. */
  columns: readonly [string, string, string, string];
  rows: readonly MonthTableRow[];
  totalLabel: string;
  total: ReactNode;
  /** A fifth column's heading, after cost; each row fills it with `extra`. */
  extraColumn?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [group, runs, share, cost] = columns;
  const span = extraColumn === undefined ? 4 : 5;
  return (
    <div className="min-w-0 overflow-x-auto">
      <table
        aria-label={label}
        className="w-full min-w-[560px] border-collapse text-sm"
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
            {extraColumn === undefined ? null : (
              <th scope="col" className={`${headCell} text-right`}>
                {extraColumn}
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, index) => {
            const isOpen = open === row.key;
            const listId = `spend-month-runs-${String(index)}`;
            const toggle = () => {
              setOpen(isOpen ? null : row.key);
            };
            return [
              <tr
                key={row.key}
                data-key={row.key}
                className="transition-colors hover:bg-hl"
              >
                <th scope="row" className={`${cell} text-left font-normal`}>
                  {row.runList === null ? (
                    <span className="flex min-w-0 items-center gap-2 pl-8">
                      {row.label}
                    </span>
                  ) : (
                    <span className="flex min-w-0 items-center gap-2">
                      <button
                        type="button"
                        aria-label={row.toggleLabel}
                        aria-expanded={isOpen}
                        aria-controls={listId}
                        onClick={toggle}
                        className="flex size-6 flex-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        <CaretRightIcon
                          aria-hidden="true"
                          className={`size-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
                        />
                      </button>
                      {row.label}
                    </span>
                  )}
                </th>
                <td className={numericCell}>{row.runs}</td>
                <td className={cell}>{row.share}</td>
                <td className={numericCell}>{row.cost}</td>
                {extraColumn === undefined ? null : (
                  <td className={numericCell}>
                    <ExtraCell
                      extra={row.extra}
                      opens={row.runList !== null}
                      isOpen={isOpen}
                      listId={listId}
                      onToggle={toggle}
                    />
                  </td>
                )}
              </tr>,
              row.runList === null ? null : (
                <tr
                  key={`${row.key}:runs`}
                  id={listId}
                  hidden={!isOpen}
                  className="bg-hl/40"
                >
                  <td colSpan={span} className="px-3 py-2">
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
            {extraColumn === undefined ? null : <td className={cell} />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
