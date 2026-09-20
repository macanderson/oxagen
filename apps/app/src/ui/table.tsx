// A list table: one header row and a body the caller fills with rows. On a
// phone the shell turns it into labelled cards (features/shell/card-tables.ts),
// so a table must keep a single header row with no grouped header.
import type { ReactNode } from "react";

type TableColumn = { label: string; numeric?: boolean };

/** Class recipes for the caller's cells, so a numeric column aligns with its header. */
export const cell = "px-3 py-2.5 align-middle";
/*
 * A numeric cell takes the mono face: the kit assigns code, logs, digests and
 * the numbers in tables to Monaspace Neon, so a column of figures reads as one
 * column rather than as prose that happens to be digits.
 */
export const numericCell = `${cell} whitespace-nowrap text-right font-mono tabular-nums`;

export function Table({
  label,
  columns,
  children,
}: {
  /** The table's accessible name, already translated. */
  label: string;
  columns: readonly TableColumn[];
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table
        aria-label={label}
        className="w-full min-w-[560px] border-collapse text-[13px]"
      >
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            {columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className={`whitespace-nowrap bg-muted/40 px-3 py-2 text-[11px] font-semibold ${column.numeric === true ? "text-right" : "text-left"}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-muted/30">
          {children}
        </tbody>
      </table>
    </div>
  );
}
