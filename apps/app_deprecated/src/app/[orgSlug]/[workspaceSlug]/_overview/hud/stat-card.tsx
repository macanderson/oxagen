/**
 * stat-card.tsx — compact KPI card for the Overview HUD.
 *
 * Pure presentational, server-safe (no hooks). A single metric: an icon-tinted
 * label, a large tabular value, an optional sub-line and delta chip, and an
 * optional trailing visual (sparkline / mini-bars) pinned to the right. When
 * `href` is set the whole card is a Link with hover affordance. Composes the
 * shared Card primitive so it inherits the app's surface/border tokens.
 */
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  /** Muted line under the value, e.g. "1,204 LLM calls". */
  sub?: React.ReactNode;
  /** Delta chip or other inline change indicator, rendered beside the sub-line. */
  delta?: React.ReactNode;
  /** Trailing visual pinned right (sparkline / mini-bars). */
  visual?: React.ReactNode;
  href?: string;
  className?: string;
  "data-testid"?: string;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  sub,
  delta,
  visual,
  href,
  className,
  "data-testid": testId,
}: StatCardProps) {
  const body = (
    <div className="flex h-full flex-col gap-1.5">
      {/* Label owns the full card width — the trailing visual shares the row
          with the value below instead, so a label like "Spend · month to
          date" never truncates just because a sparkline reserved half the
          card. `truncate` stays as the narrow-viewport backstop. */}
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon ? (
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        ) : null}
        <span className="truncate">{label}</span>
      </span>
      <div className="flex flex-1 items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-2xl font-semibold leading-none tabular-nums text-foreground">
            {value}
          </span>
          {(sub || delta) && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              {delta}
              {sub}
            </span>
          )}
        </div>
        {/* Muted stroke: a KPI trend is contextual detail — in brand
            terracotta a downward line reads like a red alert. */}
        {visual ? (
          <div className="shrink-0 text-muted-foreground/70">{visual}</div>
        ) : null}
      </div>
    </div>
  );

  if (href) {
    return (
      <Card interactive className={cn("p-0", className)} data-testid={testId}>
        <Link href={href} className="block h-full p-4">
          {body}
        </Link>
      </Card>
    );
  }

  return (
    <Card className={cn("p-4", className)} data-testid={testId}>
      {body}
    </Card>
  );
}
