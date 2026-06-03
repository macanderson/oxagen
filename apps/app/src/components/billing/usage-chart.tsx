import { Card, CardPanel, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

export interface UsageMetric {
  metric: string;
  quantity: number;
  totalCostMicros: number;
}

export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  metrics: UsageMetric[];
}

export function UsageChart({ usage }: { usage: UsageSummary }) {
  const max = Math.max(1, ...usage.metrics.map((m) => m.quantity));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Current period usage</CardTitle>
        <CardDescription>
          {new Date(usage.periodStart).toLocaleDateString()} → {new Date(usage.periodEnd).toLocaleDateString()}
        </CardDescription>
      </CardHeader>
      <CardPanel>
        {usage.metrics.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage yet this period.</p>
        ) : (
          <ul className="space-y-3">
            {usage.metrics.map((m) => {
              const pct = Math.round((m.quantity / max) * 100);
              return (
                <li key={m.metric}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{m.metric}</span>
                    <span className="text-muted-foreground">
                      {m.quantity.toLocaleString()} • {formatCents(Math.round(m.totalCostMicros / 10_000))}
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardPanel>
    </Card>
  );
}
