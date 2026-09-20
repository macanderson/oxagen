// A list table: one header row and a body the caller fills with rows. On a
// phone the shell turns it into labelled cards (features/shell/card-tables.ts),
// so a table must keep a single header row with no grouped header.
//
// The shape is the mockup's `table`, `th` and `td` rules (engine.css, ADR-132):
// 13px rows on the panel, a header in 10.5px caps and the dim ink with no band
// behind it, and the wash on a hovered row. globals.css carries the same rule
// for every table under the shell, so a caller that draws its own <table>
// cannot fall off it.
import type { ReactNode } from "react";

type TableColumn = { label: string; numeric?: boolean };

/** `th,td { padding:9px 12px; vertical-align:middle }` */
export const cell = "px-3 py-[9px] align-middle";
/*
 * A numeric cell takes the mono face: the kit assigns code, logs, digests and
 * the numbers in tables to Monaspace Neon, so a column of figures reads as one
 * column rather than as prose that happens to be digits.
 */
export const numericCell = `${cell} whitespace-nowrap text-right font-mono tabular-nums`;

/** `th { font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--dim) }` */
export const headCell =
  "whitespace-nowrap bg-card px-3 py-[9px] text-[10.5px] font-semibold uppercase tracking-[0.09em] text-dim";

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
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                key={column.label}
                scope="col"
                className={`${headCell} ${column.numeric === true ? "text-right" : "text-left"}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border [&>tr]:transition-colors [&>tr:hover]:bg-hl">
          {children}
        </tbody>
      </table>
    </div>
  );
}
