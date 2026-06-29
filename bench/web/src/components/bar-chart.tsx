// Imported only into the client graph (via results-tab → benchmark-dashboard),
// so no own "use client" directive is needed.
import { motion } from "motion/react";
import { cn } from "@/lib/format";

export interface BarDatum {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** Pre-formatted value shown at the end of the bar. */
  readonly display: string;
  readonly color: string;
  /** When true, a higher value is better (affects nothing visually; documents intent). */
  readonly higherIsBetter?: boolean;
}

/**
 * Lightweight horizontal bar chart. Built with divs + a motion width animation
 * rather than a charting dependency, so the benchmark app stays self-contained
 * and SSR-safe.
 */
export function BarChart({
  data,
  className,
}: {
  readonly data: readonly BarDatum[];
  readonly className?: string;
}): React.ReactElement {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {data.map((d) => {
        const pct = Math.max(2, Math.round((d.value / max) * 100));
        return (
          <div key={d.key} className="flex items-center gap-3">
            <div className="w-32 shrink-0 truncate text-sm text-graphite-300" title={d.label}>
              {d.label}
            </div>
            <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-graphite-850">
              <motion.div
                className="h-full rounded-md"
                style={{ backgroundColor: d.color }}
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.6, ease: "easeOut" }}
              />
              <span className="absolute inset-y-0 right-2 flex items-center text-xs font-semibold tabular-nums text-graphite-100">
                {d.display}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
