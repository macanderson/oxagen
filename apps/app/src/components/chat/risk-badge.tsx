import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { RiskLevel } from "./stream-event-types";

/**
 * RiskBadge — a deliberately calm risk indicator for tool calls.
 *
 * Low-risk calls render nothing: the absence of a chip is the signal that
 * everything is routine. Medium/high risk render a small neutral outline
 * badge with a shield icon — informative, not alarming. Full risk detail
 * lives in the tool call's expanded body.
 */
export function RiskBadge({ risk }: { risk: RiskLevel }) {
  if (risk === "low") return null;
  return (
    <Badge
      variant="outline"
      size="sm"
      className="gap-1 font-normal text-muted-foreground"
      data-testid="risk-badge"
      data-risk={risk}
    >
      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
      {risk === "high" ? "High risk" : "Medium risk"}
    </Badge>
  );
}
