import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  orderedCounts,
  COMPLIANCE_ORDER,
  type ComplianceKey,
} from "@/app/[orgSlug]/[workspaceSlug]/knowledge/citations/citations-format";

// Same influence/compliance color language as memory-citations-panel.tsx (the
// per-execution citations panel) so the two Citations surfaces read
// consistently — VIOLATION is the outcome that matters most and is called out
// in its own alert row below the badge grid, not just colored.
const COMPLIANCE_CONFIG: Record<
  ComplianceKey,
  { label: string; className: string }
> = {
  COMPLIED: {
    label: "Complied",
    className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  DISCRETION: {
    label: "Discretion",
    className: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  },
  VIOLATION: {
    label: "Violation",
    className: "bg-red-500/15 text-red-700 dark:text-red-400",
  },
  NA: {
    label: "N/A",
    className: "bg-zinc-400/20 text-zinc-600 dark:text-zinc-400",
  },
};

export interface CitationComplianceSummaryProps {
  byCompliance: Record<string, number>;
}

/** Server-safe breakdown of citations by compliance outcome — no chart needed. */
export function CitationComplianceSummary({
  byCompliance,
}: CitationComplianceSummaryProps) {
  const rows = orderedCounts(COMPLIANCE_ORDER, byCompliance);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const violations = rows.find((r) => r.key === "VIOLATION")?.count ?? 0;

  if (total === 0) {
    return (
      <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
        No citations recorded in this window yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {rows.map((r) => (
          <div
            key={r.key}
            className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2"
          >
            <Badge className={`${COMPLIANCE_CONFIG[r.key].className} border-0`}>
              {COMPLIANCE_CONFIG[r.key].label}
            </Badge>
            <span className="text-sm font-medium tabular-nums text-foreground">
              {r.count.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
      {violations > 0 ? (
        <div className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {violations.toLocaleString()} rule violation
          {violations === 1 ? "" : "s"} recorded in this window — see Most
          Violated Rules below.
        </div>
      ) : null}
    </div>
  );
}
