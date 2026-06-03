import { Badge } from "@/components/ui/badge";
import type { RiskLevel } from "./stream-event-types";

// Risk -> badge variant mapping mirrors the spec: low=neutral, medium=amber,
// high=red. Kept in one component so every card reads the same colors.
export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const variant = risk === "high" ? "destructive" : risk === "medium" ? "warning" : "muted";
  return (
    <Badge variant={variant} className="uppercase tracking-wide">
      {risk} risk
    </Badge>
  );
}
