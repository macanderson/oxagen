// A stat tile: a label, one value, and a line of context under it (the basis,
// a share, a trend). The value is whatever the caller renders, usually <Money>.
import type { ReactNode } from "react";

export type TileProps = {
  /** Already translated. */
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** A chart under the numbers (a <Sparkline> or a <Meter>). */
  chart?: ReactNode;
};

export function Tile({ label, value, sub, chart }: TileProps) {
  return (
    <section
      aria-label={label}
      data-testid="tile"
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card p-3"
    >
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="text-xl font-semibold leading-tight tabular-nums text-foreground">
        {value}
      </div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
      {chart ? <div className="pt-1">{chart}</div> : null}
    </section>
  );
}
