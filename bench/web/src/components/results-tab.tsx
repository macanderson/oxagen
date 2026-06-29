// Imported only into the client graph (via benchmark-dashboard), so no own
// "use client" directive is needed.
import { Card, SectionTitle, Stat } from "@/components/atoms";
import { BarChart, type BarDatum } from "@/components/bar-chart";
import { AGENTS_BY_ID } from "@/lib/data";
import { formatDuration, formatPercent, formatPercent1, formatTokens } from "@/lib/format";
import type { AgentSummary, BenchmarkRun, FailureMode, TaskResult } from "@/lib/types";

const FAILURE_LABELS: Readonly<Record<FailureMode, string>> = {
  "wrong-answer": "Wrong answer",
  timeout: "Timeout",
  error: "Error",
};

function agentColor(id: AgentSummary["agentId"]): string {
  return AGENTS_BY_ID[id]?.color ?? "#8a949d";
}

function agentName(id: AgentSummary["agentId"]): string {
  return AGENTS_BY_ID[id]?.name ?? id;
}

function ranked(summaries: readonly AgentSummary[]): AgentSummary[] {
  return [...summaries].sort((a, b) => a.rank - b.rank);
}

function failureCounts(results: readonly TaskResult[]): Record<FailureMode, number> {
  const counts: Record<FailureMode, number> = { "wrong-answer": 0, timeout: 0, error: 0 };
  for (const r of results) {
    if (!r.passed && r.failureMode) counts[r.failureMode]++;
  }
  return counts;
}

export function ResultsTab({
  run,
  onReset,
}: {
  readonly run: BenchmarkRun;
  readonly onReset: () => void;
}): React.ReactElement {
  const order = ranked(run.summaries);
  const winner = order[0];

  const scoreData: BarDatum[] = order.map((s) => ({
    key: s.agentId,
    label: agentName(s.agentId),
    value: s.score,
    display: s.score.toFixed(0),
    color: agentColor(s.agentId),
    higherIsBetter: true,
  }));

  const passRateData: BarDatum[] = order.map((s) => ({
    key: s.agentId,
    label: agentName(s.agentId),
    value: s.passRate,
    display: formatPercent(s.passRate),
    color: agentColor(s.agentId),
    higherIsBetter: true,
  }));

  const speedData: BarDatum[] = order.map((s) => ({
    key: s.agentId,
    label: agentName(s.agentId),
    value: s.avgDurationMs,
    display: formatDuration(s.avgDurationMs),
    color: agentColor(s.agentId),
  }));

  const tokenData: BarDatum[] = order.map((s) => ({
    key: s.agentId,
    label: agentName(s.agentId),
    value: s.avgTokens,
    display: formatTokens(s.avgTokens),
    color: agentColor(s.agentId),
  }));

  const failures = failureCounts(run.results);
  const totalFailures = Object.values(failures).reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col gap-5">
      <Card className="border-ember/40 bg-gradient-to-br from-ember/10 to-transparent">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-graphite-400">Winner</div>
            <div className="mt-1 flex items-center gap-3">
              <span
                className="size-4 rounded-full"
                style={{ backgroundColor: winner ? agentColor(winner.agentId) : undefined }}
              />
              <span className="text-2xl font-bold text-graphite-100">
                {winner ? agentName(winner.agentId) : "—"}
              </span>
              {winner ? (
                <span className="rounded-md bg-ember/20 px-2 py-0.5 text-sm font-semibold text-ember">
                  Score {winner.score.toFixed(0)}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-8">
            <Stat label="Difficulty" value={run.difficulty} />
            <Stat label="Tasks" value={`${run.results.length}`} />
            <Stat label="Failures" value={`${totalFailures}`} />
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg border border-graphite-600 px-4 py-2 text-sm font-medium text-graphite-200 hover:border-ember/60 hover:text-graphite-100"
            >
              New run
            </button>
          </div>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <SectionTitle title="Composite score" hint="higher is better" />
          <BarChart data={scoreData} />
        </Card>
        <Card>
          <SectionTitle title="Pass rate" hint="higher is better" />
          <BarChart data={passRateData} />
        </Card>
        <Card>
          <SectionTitle title="Avg time per task" hint="lower is better" />
          <BarChart data={speedData} />
        </Card>
        <Card>
          <SectionTitle title="Avg tokens per task" hint="lower is better" />
          <BarChart data={tokenData} />
        </Card>
      </div>

      <Card>
        <SectionTitle title="Comparative results" />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-graphite-700 text-xs uppercase tracking-wide text-graphite-400">
                <th className="px-3 py-2 font-medium">Rank</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 text-right font-medium">Score</th>
                <th className="px-3 py-2 text-right font-medium">Pass rate</th>
                <th className="px-3 py-2 text-right font-medium">Avg accuracy</th>
                <th className="px-3 py-2 text-right font-medium">Avg time</th>
                <th className="px-3 py-2 text-right font-medium">Avg tokens</th>
              </tr>
            </thead>
            <tbody>
              {order.map((s) => (
                <tr key={s.agentId} className="border-b border-graphite-800/70 last:border-0">
                  <td className="px-3 py-2 tabular-nums text-graphite-400">#{s.rank}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: agentColor(s.agentId) }}
                      />
                      <span className="font-medium text-graphite-100">{agentName(s.agentId)}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-graphite-100">
                    {s.score.toFixed(0)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-graphite-200">
                    {formatPercent(s.passRate)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-graphite-200">
                    {formatPercent1(s.avgAccuracy)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-graphite-200">
                    {formatDuration(s.avgDurationMs)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-graphite-200">
                    {formatTokens(s.avgTokens)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <SectionTitle title="Failure modes" hint={`${totalFailures} failed tasks`} />
        {totalFailures === 0 ? (
          <p className="text-sm text-emerald-400">No failures — every task passed.</p>
        ) : (
          <div className="grid grid-cols-3 gap-4">
            {(Object.keys(FAILURE_LABELS) as FailureMode[]).map((mode) => (
              <div key={mode} className="rounded-lg bg-graphite-850 p-4">
                <div className="text-2xl font-semibold tabular-nums text-graphite-100">
                  {failures[mode]}
                </div>
                <div className="text-xs uppercase tracking-wide text-graphite-400">
                  {FAILURE_LABELS[mode]}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
