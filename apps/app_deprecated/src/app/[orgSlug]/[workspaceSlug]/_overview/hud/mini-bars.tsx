/**
 * mini-bars.tsx — minimal inline SVG bar chart, no axes/labels/interactivity.
 *
 * Pure presentational, server-safe (no hooks, no client runtime) so it streams
 * inside a Server Component without shipping a charting bundle. Bars scale to
 * the tallest value; an all-zero series renders flat baseline stubs instead of
 * dividing by zero. The final bar can be emphasised (e.g. "today") via
 * `highlightLast`.
 */
import { cn } from "@/lib/utils";

export interface MiniBarsProps {
  values: number[];
  width?: number;
  height?: number;
  gap?: number;
  highlightLast?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function MiniBars({
  values,
  width = 140,
  height = 40,
  gap = 2,
  highlightLast = false,
  className,
  "aria-label": ariaLabel = "Recent trend",
}: MiniBarsProps) {
  if (values.length === 0) return null;

  const max = Math.max(...values, 0);
  const n = values.length;
  const barWidth = Math.max((width - gap * (n - 1)) / n, 1);
  const minStub = 1.5; // visible baseline for zero-value days

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={ariaLabel}
      data-testid="overview-mini-bars"
    >
      {values.map((v, i) => {
        // Every bar keeps at least `minStub` height so a zero day still shows a
        // baseline tick rather than vanishing (and so max === 0 never divides).
        const h = max > 0 ? Math.max((v / max) * height, minStub) : minStub;
        const x = i * (barWidth + gap);
        const y = height - h;
        const isLast = highlightLast && i === n - 1;
        return (
          <rect
            key={i}
            x={x.toFixed(2)}
            y={y.toFixed(2)}
            width={barWidth.toFixed(2)}
            height={h.toFixed(2)}
            rx={Math.min(barWidth / 2, 1.5).toFixed(2)}
            className={cn(
              isLast ? "fill-primary" : "fill-primary/35",
              v === 0 && "fill-muted-foreground/20",
            )}
          />
        );
      })}
    </svg>
  );
}
