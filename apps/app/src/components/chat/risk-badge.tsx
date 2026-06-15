import { cn } from "@/lib/utils";
import type { RiskLevel } from "./stream-event-types";

// Jewel-tone risk color map per design system:
//   low    = green  #67d182 with semi-transparent bg
//   medium = amber  #ffbe63 with semi-transparent bg
//   high   = salmon #ff8a6b with semi-transparent bg
const RISK_STYLES: Record<RiskLevel, { color: string; bg: string }> = {
  low: { color: "#67d182", bg: "rgba(103,209,130,0.12)" },
  medium: { color: "#ffbe63", bg: "rgba(255,190,99,0.12)" },
  high: { color: "#ff8a6b", bg: "rgba(255,138,107,0.12)" },
};

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const { color, bg } = RISK_STYLES[risk];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
      )}
      style={{ color, backgroundColor: bg, border: `1px solid ${color}33` }}
    >
      {risk} risk
    </span>
  );
}
