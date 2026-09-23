// The design's `.banner` over Fleet (engine.js `obFleetBanners`): a state
// pill, a bold title with its sentence beside it, and one small action. The
// pill carries the design's tone (`b-denied` for provisional, `b-q` for the
// first run) with no dot, as the design draws it.
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "@/ui/badge";

export function GateBanner({
  testId,
  badge,
  tone,
  title,
  children,
  action,
}: {
  testId: string;
  badge: string;
  tone: BadgeTone;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="flex flex-col gap-2 rounded-xl border border-border bg-banner p-4 text-card-foreground shadow-sm sm:flex-row sm:items-start sm:gap-4"
    >
      <span className="flex-none">
        <Badge tone={tone} dot={false} data-banner-badge={tone}>
          {badge}
        </Badge>
      </span>
      <div className="flex min-w-0 grow flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <div className="max-w-prose text-sm text-muted-foreground">
          {children}
        </div>
      </div>
      {action === undefined ? null : (
        <div className="flex flex-none items-center">{action}</div>
      )}
    </section>
  );
}
