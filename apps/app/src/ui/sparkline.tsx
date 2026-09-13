// A single-series trend: one thin line over a faint area, in one hue, with no
// legend and no axis. The numbers it summarises live in text beside it.
import { cx } from "./cx";

export type SparklinePaths = { line: string; area: string };

/**
 * SVG path data for `points` in a `width` × `height` box. The scale runs from
 * the smaller of zero and the minimum to the maximum, so a flat series sits on
 * the baseline and a negative one stays inside the box. Fewer than two points
 * draw nothing.
 */
export function sparklinePaths(
  points: readonly (number | bigint)[],
  width: number,
  height: number,
  pad = 3,
): SparklinePaths | null {
  if (points.length < 2) return null;
  const values = points.map(Number);
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const step = (width - 2 * pad) / (values.length - 1);
  const x = (i: number) => (pad + i * step).toFixed(1);
  const y = (v: number) =>
    (height - pad - ((v - min) / span) * (height - 2 * pad)).toFixed(1);
  const line = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(v)}`)
    .join(" ");
  const base = (height - pad).toFixed(1);
  const area = `${line} L${x(values.length - 1)} ${base} L${x(0)} ${base} Z`;
  return { line, area };
}

export type SparklineProps = {
  points: readonly (number | bigint)[];
  /** Already translated: what the series is, e.g. "Spend per day, last 30 days". */
  label: string;
  /** One label per point ("Sep 11 · $41.20"), shown on hover. */
  pointLabels?: readonly string[];
  width?: number;
  height?: number;
  className?: string;
};

export function Sparkline({
  points,
  label,
  pointLabels,
  width = 240,
  height = 48,
  className,
}: SparklineProps) {
  const paths = sparklinePaths(points, width, height);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      data-testid="sparkline"
      className={cx("block h-12 w-full text-chart-2", className)}
    >
      {paths ? (
        <>
          <path d={paths.area} fill="currentColor" opacity={0.08} />
          <path
            d={paths.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      ) : null}
      {pointLabels?.slice(0, points.length).map((text, i) => (
        <rect
          // Points are positional; the index is their identity.
          key={`${String(i)}-${text}`}
          x={i * step - step / 2}
          y={0}
          width={step}
          height={height}
          fill="transparent"
        >
          <title>{text}</title>
        </rect>
      ))}
    </svg>
  );
}
