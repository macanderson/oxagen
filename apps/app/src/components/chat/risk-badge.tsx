import { cn } from "@/lib/utils";
import type { RiskLevel } from "./stream-event-types";

// Token-driven risk color map (earthy status tokens):
//   low = success · medium = warning · high = error
const RISK_TOKEN: Record<RiskLevel, string> = {
  low: "var(--success)",
  medium: "var(--warning)",
  high: "var(--error)",
};

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const color = RISK_TOKEN[risk];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
      )}
      style={{
        color,
        backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 20%, transparent)`,
      }}
    >
      {risk} risk
    </span>
  );
}
