// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card, SectionTitle } from "@/components/atoms";
import { BarChart, type BarDatum } from "@/components/bar-chart";
import { formatPercent1 } from "@/lib/format";
import type { AgentSummaryRow } from "@/lib/types";

const MEASURED_COLOR = "#F87854";
const SAMPLE_COLOR = "#F5B23A";

/** Visualizes each row's resolved rate; sample rows render in the warning color. */
export function ResolvedRateChart({
  rows,
}: {
  readonly rows: readonly AgentSummaryRow[];
}): React.ReactElement | null {
  if (rows.length === 0) return null;

  const data: BarDatum[] = rows.map((row) => ({
    key: row.runId,
    label: `${row.agentName} (${row.model})`,
    value: row.resolvedRate,
    display: formatPercent1(row.resolvedRate),
    color: row.provenance.kind === "sample" ? SAMPLE_COLOR : MEASURED_COLOR,
    higherIsBetter: true,
  }));

  return (
    <Card>
      <SectionTitle title="Resolved rate" hint="higher is better" />
      <BarChart data={data} />
    </Card>
  );
}
