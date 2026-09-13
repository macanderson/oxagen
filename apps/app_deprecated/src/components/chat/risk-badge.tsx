import { ShieldAlert } from "lucide-react";
import type { RiskLevel } from "./stream-event-types";

/**
 * RiskBadge — a deliberately calm risk indicator for tool calls.
 *
 * Low-risk calls render nothing: the absence of any marker is the signal that
 * everything is routine. Medium/high risk render a small muted inline label
 * with a shield icon — informative, not alarming, and no chip/border so it
 * never competes with the surrounding card. Full risk detail lives in the
 * tool call's expanded body.
 */
export function RiskBadge({ risk }: { risk: RiskLevel }) {
  if (risk === "low") return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      data-testid="risk-badge"
      data-risk={risk}
    >
      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
      {risk === "high" ? "High risk" : "Medium risk"}
    </span>
  );
}
