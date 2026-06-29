"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SetupTab } from "@/components/setup-tab";
import { RunningTab } from "@/components/running-tab";
import { ResultsTab } from "@/components/results-tab";
import { runBenchmark } from "@/lib/benchmark";
import { AGENTS, EVALS } from "@/lib/data";
import { cn } from "@/lib/format";
import type { AgentId, BenchmarkRun, Difficulty } from "@/lib/types";

type Tab = "setup" | "running" | "results";
type Phase = "idle" | "running" | "done";

const ALL_AGENT_IDS: readonly AgentId[] = AGENTS.map((a) => a.id);
const ALL_EVAL_IDS: readonly string[] = EVALS.map((e) => e.id);

function tabLabel(tab: Tab): string {
  return tab === "setup" ? "Setup" : tab === "running" ? "Running" : "Results";
}

export function BenchmarkDashboard(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("setup");
  const [phase, setPhase] = useState<Phase>("idle");
  const [selectedAgents, setSelectedAgents] = useState<readonly AgentId[]>(ALL_AGENT_IDS);
  const [selectedEvals, setSelectedEvals] = useState<readonly string[]>(ALL_EVAL_IDS);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [revealed, setRevealed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toggleAgent = useCallback((id: AgentId) => {
    setSelectedAgents((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...ALL_AGENT_IDS].filter((a) => prev.includes(a) || a === id),
    );
  }, []);

  const toggleEval = useCallback((id: string) => {
    setSelectedEvals((prev) =>
      prev.includes(id) ? prev.filter((e) => e !== id) : [...ALL_EVAL_IDS].filter((e) => prev.includes(e) || e === id),
    );
  }, []);

  const startRun = useCallback(() => {
    if (selectedAgents.length === 0 || selectedEvals.length === 0) return;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const computed = runBenchmark({
      agentIds: selectedAgents,
      evalIds: selectedEvals,
      difficulty,
      seed,
    });
    setRun(computed);
    setRevealed(0);
    setPhase("running");
    setTab("running");
  }, [selectedAgents, selectedEvals, difficulty]);

  const reset = useCallback(() => {
    setPhase("idle");
    setRun(null);
    setRevealed(0);
    setTab("setup");
  }, []);

  // Reveal task results progressively to simulate a live run. The full result
  // set is computed synchronously by runBenchmark(); this only paces the UI.
  useEffect(() => {
    if (phase !== "running" || !run) return;
    const total = run.results.length;
    const tick = Math.max(60, Math.min(220, Math.round(7000 / Math.max(1, total))));
    intervalRef.current = setInterval(() => {
      setRevealed((prev) => {
        const next = prev + 1;
        if (next >= total) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setPhase("done");
          return total;
        }
        return next;
      });
    }, tick);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [phase, run]);

  // Once revealing finishes, advance to the results view.
  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(() => setTab("results"), 650);
    return () => clearTimeout(t);
  }, [phase]);

  const hasRun = run !== null;
  const tabs = useMemo<readonly Tab[]>(() => ["setup", "running", "results"], []);

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-ember/15 text-xl">🜂</span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-graphite-100">
              Oxagen Benchmark Suite
            </h1>
            <p className="text-sm text-graphite-400">
              Compare AI code agents across 12 evaluations.
            </p>
          </div>
        </div>
        <nav className="flex gap-1 rounded-xl border border-graphite-700 bg-graphite-900 p-1">
          {tabs.map((t) => {
            const disabled = (t === "running" || t === "results") && !hasRun;
            return (
              <button
                key={t}
                type="button"
                disabled={disabled}
                onClick={() => setTab(t)}
                aria-current={tab === t}
                className={cn(
                  "rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  tab === t
                    ? "bg-ember text-graphite-950"
                    : "text-graphite-300 hover:text-graphite-100",
                )}
              >
                {tabLabel(t)}
              </button>
            );
          })}
        </nav>
      </header>

      {tab === "setup" ? (
        <SetupTab
          selectedAgents={selectedAgents}
          selectedEvals={selectedEvals}
          difficulty={difficulty}
          onToggleAgent={toggleAgent}
          onToggleEval={toggleEval}
          onSetDifficulty={setDifficulty}
          onSelectAllEvals={() => setSelectedEvals(ALL_EVAL_IDS)}
          onClearEvals={() => setSelectedEvals([])}
          onRun={startRun}
        />
      ) : null}

      {tab === "running" && run ? (
        <RunningTab run={run} revealed={revealed} done={phase === "done"} />
      ) : null}

      {tab === "results" && run ? <ResultsTab run={run} onReset={reset} /> : null}

      <footer className="mt-10 text-center text-xs text-graphite-600">
        Deterministic simulation — results are derived from published agent
        profiles, not live agent runs. Launch with{" "}
        <code className="rounded bg-graphite-850 px-1.5 py-0.5 text-graphite-400">pnpm eval:app</code>.
      </footer>
    </main>
  );
}
