// A share of a whole as one bar in one hue: magnitude, never identity. The
// value and maximum may be bigints (micros), so the share is computed without
// a float until the final percentage.
import { cx } from "./cx";

export type MeterProps = {
  /** Already translated; names the meter for assistive technology. */
  label: string;
  value: number | bigint;
  max: number | bigint;
  /** The value as a person reads it ("$1,204.00 of $3,000.00"). */
  valueText: string;
  /** Show the label and value text above the bar. */
  showText?: boolean;
  className?: string;
};

/** The share of `max` that `value` is, as a percentage clamped to 0–100 with two decimals. */
export function meterPercent(
  value: number | bigint,
  max: number | bigint,
): number {
  if (typeof value === "bigint" || typeof max === "bigint") {
    const v = typeof value === "bigint" ? value : BigInt(Math.round(value));
    const m = typeof max === "bigint" ? max : BigInt(Math.round(max));
    if (m <= 0n) return 0;
    const basisPoints = (v * 10_000n) / m;
    const clamped =
      basisPoints < 0n ? 0n : basisPoints > 10_000n ? 10_000n : basisPoints;
    return Number(clamped) / 100;
  }
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 10_000) / 100));
}

export function Meter({
  label,
  value,
  max,
  valueText,
  showText = false,
  className,
}: MeterProps) {
  const percent = meterPercent(value, max);
  // A non-zero share never renders as an empty bar.
  const width = value > 0 && max > 0 ? Math.max(1, percent) : 0;
  return (
    <div className={cx("flex min-w-0 flex-col gap-1", className)}>
      {showText ? (
        <div className="flex items-baseline gap-2 text-xs">
          <span className="truncate text-muted-foreground">{label}</span>
          <span className="ml-auto shrink-0 font-semibold tabular-nums text-foreground">
            {valueText}
          </span>
        </div>
      ) : null}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-chart-2"
          style={{ width: `${String(width)}%` }}
        />
      </div>
    </div>
  );
}
