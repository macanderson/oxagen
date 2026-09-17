/**
 * delta-chip.tsx — period-over-period change indicator.
 *
 * Pure presentational, server-safe (no hooks, no client runtime). Renders a
 * small arrow + percentage comparing `current` to `previous`, colour-coded by
 * whether the movement is "good" for this metric (spend going up is bad; nodes
 * created going up is good — caller sets `goodDirection`). A previous value of
 * zero is shown as a neutral "new" chip instead of a divide-by-zero infinity.
 */
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DeltaChipProps {
  current: number;
  previous: number;
  /** Which direction is a positive outcome. Default "up". */
  goodDirection?: "up" | "down";
  /** Trailing context, e.g. "vs yesterday". */
  label?: string;
  className?: string;
}

function formatPct(pct: number): string {
  const abs = Math.abs(pct);
  if (abs >= 100) return `${Math.round(abs)}%`;
  if (abs >= 10) return `${abs.toFixed(0)}%`;
  return `${abs.toFixed(1)}%`;
}

export function DeltaChip({
  current,
  previous,
  goodDirection = "up",
  label,
  className,
}: DeltaChipProps) {
  const dir: "up" | "down" | "flat" =
    current > previous ? "up" : current < previous ? "down" : "flat";

  // No prior baseline: brand-new activity. Neutral, not a fake ∞%.
  const isNew = previous === 0 && current > 0;
  const pct = previous === 0 ? 0 : ((current - previous) / previous) * 100;

  const isGood = dir === "flat" ? null : dir === goodDirection;
  const tone =
    isNew || dir === "flat"
      ? "text-muted-foreground"
      : isGood
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-rose-600 dark:text-rose-400";

  const Icon =
    dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium tabular-nums",
        tone,
        className,
      )}
      data-testid="delta-chip"
      data-direction={dir}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{isNew ? "new" : dir === "flat" ? "0%" : formatPct(pct)}</span>
      {label ? (
        <span className="font-normal text-muted-foreground">{label}</span>
      ) : null}
    </span>
  );
}
