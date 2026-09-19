// A list table: one header row and a body the caller fills with rows. On a
// phone the shell turns it into labelled cards (features/shell/card-tables.ts),
// so a table must keep a single header row with no grouped header.
import type { ReactNode } from "react";

type TableColumn = { label: string; numeric?: boolean };

/** Class recipes for the caller's cells, so a numeric column aligns with its header. */
export const cell = "px-3 py-2.5 align-top";
/*
 * A numeric cell takes the mono face: the kit assigns code, logs, digests and
 * the numbers in tables to Monaspace Neon, so a column of figures reads as one
 * column rather than as prose that happens to be digits.
 */
export const numericCell = `${cell} text-right font-mono tabular-nums`;

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
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            {columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className={`px-3 py-2 font-medium ${column.numeric === true ? "text-right" : "text-left"}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}
