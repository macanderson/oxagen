/**
 * Sparkline — minimal inline SVG trend line, no axes/labels/interactivity.
 *
 * Pure presentational, server-safe (no hooks, no client runtime). Renders a
 * single polyline scaled to fit the viewBox; degenerate inputs (0 or 1 point,
 * or a flat series) fall back to a straight line instead of dividing by zero.
 */
export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  "aria-label"?: string;
}

export function Sparkline({
  values,
  width = 120,
  height = 32,
  className,
  "aria-label": ariaLabel = "Trend",
}: SparklineProps) {
  if (values.length === 0) return null;

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;

  const points = values
    .map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label={ariaLabel}
      // Generic: the KPI strip renders one of these per metric (spend, tokens,
      // runs), so this id is never unique in the document — select the owning
      // StatCard's testid and scope the query, don't getByTestId this one.
      data-testid="overview-sparkline"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
