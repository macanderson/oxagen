// Imported only into the client graph (via benchmark-dashboard), so it inherits
// that client boundary; the React hooks below compile as client code.
import { useEffect, useRef } from "react";
import { Card } from "@/components/atoms";
import { AGENTS_BY_ID, EVALS_BY_ID } from "@/lib/data";
import { formatDuration, formatTokens } from "@/lib/format";
import type { BenchmarkRun, TaskResult } from "@/lib/types";

function logLine(result: TaskResult): { text: string; ok: boolean } {
  const agent = AGENTS_BY_ID[result.agentId];
  const evalDef = EVALS_BY_ID[result.evalId];
  const agentName = agent?.name ?? result.agentId;
  const evalName = evalDef?.name ?? result.evalId;
  const cost = `${formatDuration(result.durationMs)}, ${formatTokens(result.tokens)} tok`;
  if (result.passed) {
    return { text: `✓ ${agentName} · ${evalName} — PASS (${cost})`, ok: true };
  }
  return {
    text: `✗ ${agentName} · ${evalName} — FAIL [${result.failureMode}] (${cost})`,
    ok: false,
  };
}

export function RunningTab({
  run,
  revealed,
  done,
}: {
  readonly run: BenchmarkRun;
  readonly revealed: number;
  readonly done: boolean;
}): React.ReactElement {
  const logRef = useRef<HTMLDivElement>(null);
  const total = run.results.length;
  const shown = run.results.slice(0, revealed);
  const pct = total === 0 ? 0 : Math.round((revealed / total) * 100);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [revealed]);

  const passed = shown.filter((r) => r.passed).length;
  const failed = shown.length - passed;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-graphite-300">
            {done ? "Run complete" : "Running benchmark"}
          </h2>
          <span className="text-xs text-graphite-400 capitalize">{run.difficulty}</span>
        </div>

        <div className="mt-6 flex items-end gap-2">
          <span className="text-5xl font-bold tabular-nums text-graphite-100">{pct}</span>
          <span className="mb-1 text-xl text-graphite-400">%</span>
        </div>

        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-graphite-800">
          <div
            className="h-full rounded-full bg-ember transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-6 grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-semibold tabular-nums text-graphite-100">
              {revealed}/{total}
            </div>
            <div className="text-xs uppercase tracking-wide text-graphite-400">Tasks</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums text-emerald-400">{passed}</div>
            <div className="text-xs uppercase tracking-wide text-graphite-400">Passed</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums text-rose-400">{failed}</div>
            <div className="text-xs uppercase tracking-wide text-graphite-400">Failed</div>
          </div>
        </div>

        {!done ? (
          <p className="mt-6 flex items-center gap-2 text-sm text-graphite-400">
            <span className="size-2 animate-pulse rounded-full bg-ember" />
            Executing tasks…
          </p>
        ) : (
          <p className="mt-6 text-sm text-emerald-400">All tasks executed — see Results.</p>
        )}
      </Card>

      <Card className="flex flex-col">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-graphite-300">
          Streaming log
        </h2>
        <div
          ref={logRef}
          className="thin-scroll h-[22rem] overflow-y-auto rounded-lg bg-graphite-950/80 p-3 font-mono text-xs leading-relaxed"
        >
          {shown.length === 0 ? (
            <div className="text-graphite-400">Waiting for first task…</div>
          ) : (
            shown.map((r, i) => {
              const line = logLine(r);
              return (
                <div
                  key={`${r.agentId}-${r.evalId}-${i}`}
                  className={line.ok ? "text-graphite-300" : "text-rose-300"}
                >
                  {line.text}
                </div>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
}
