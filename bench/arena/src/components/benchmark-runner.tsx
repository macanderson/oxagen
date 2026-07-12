/**
 * Benchmark Runner Component
 *
 * GUI for configuring and running REAL benchmarks. The "Start" button POSTs to
 * /api/benchmarks/start, which spawns the actual run-benchmark CLI, then polls
 * /api/benchmarks/[id]/status for live progress. Guardrails: dry-run is the
 * default, a live (spending) run requires an explicit inline confirmation, and
 * a running benchmark can be cancelled (which tears down the run's processes).
 */

"use client";

import { useEffect, useRef, useState } from "react";

// Agent type definitions
const AGENT_TYPES = [
  {
    id: "oxagen",
    name: "Oxagen",
    description: "The Stripe-for-agents platform",
  },
  { id: "stella", name: "Stella", description: "Open-source CLI coding agent" },
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Anthropic's official CLI",
  },
] as const;

const MODELS = {
  oxagen: [
    {
      id: "anthropic/claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      cost: "$0.008/1K in, $0.024/1K out",
    },
    {
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      cost: "$0.03/1K in, $0.15/1K out",
    },
    {
      id: "anthropic/claude-opus-4.8",
      name: "Claude Opus 4.8",
      cost: "$0.15/1K in, $0.75/1K out",
    },
  ],
  stella: [
    { id: "glm-5.2", name: "GLM-5.2", cost: "~$1.4/1M in, $4.4/1M out" },
    { id: "glm-4-plus", name: "GLM-4 Plus", cost: "~$0.01/1K tokens" },
    { id: "glm-4-flash", name: "GLM-4 Flash", cost: "~$0.001/1K tokens" },
  ],
  "claude-code": [
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      cost: "$0.03/1K in, $0.15/1K out",
    },
    {
      id: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      cost: "$0.15/1K in, $0.75/1K out",
    },
  ],
} as const;

const TASK_CATEGORIES = [
  { id: "smoke", name: "Smoke Tests", description: "Quick validation tasks" },
  { id: "bug-fix", name: "Bug Fixes", description: "Fix reported issues" },
  {
    id: "feature-implementation",
    name: "Feature Implementation",
    description: "Add new functionality",
  },
  {
    id: "refactoring",
    name: "Refactoring",
    description: "Improve code structure",
  },
  { id: "testing", name: "Testing", description: "Write tests" },
] as const;

interface AgentConfig {
  type: string;
  model: string;
  enabled: boolean;
}

interface JobInfo {
  agent: string;
  model: string;
  status: string;
  pid: number | null;
  exitCode: number | null;
}

interface StartResponse {
  runId?: string;
  status?: string;
  dryRun?: boolean;
  jobs?: JobInfo[];
  message?: string;
  error?: string;
}

interface StatusResponse {
  runId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  dryRun: boolean;
  jobs: JobInfo[];
  log: string;
}

type RunState = "idle" | "confirm" | "running" | "success" | "error";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

const SELECT_CLASS =
  "rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-[var(--_ember-flame)]/60 focus:ring-2 focus:ring-[var(--_ember-flame)]/20 disabled:opacity-50";
const INPUT_CLASS =
  "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-[var(--_ember-flame)]/60 focus:ring-2 focus:ring-[var(--_ember-flame)]/20 disabled:opacity-50";

export function BenchmarkRunner() {
  const [agents, setAgents] = useState<AgentConfig[]>([
    { type: "oxagen", model: "anthropic/claude-sonnet-5", enabled: true },
  ]);
  const [selectedCategory, setSelectedCategory] = useState("smoke");
  const [budget, setBudget] = useState(25);
  const [timeoutSecs, setTimeoutSecs] = useState(600);
  const [concurrent, setConcurrent] = useState(1);
  // Safe by default: a live run (real spend) must be explicitly opted into.
  const [dryRun, setDryRun] = useState(true);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [log, setLog] = useState("");

  // Poll guard — flipped off on cancel, terminal state, or unmount so no
  // interval outlives the component.
  const pollingRef = useRef(false);
  useEffect(() => {
    return () => {
      pollingRef.current = false;
    };
  }, []);

  const addAgent = () => {
    const existingTypes = agents.map((a) => a.type);
    const availableType = AGENT_TYPES.find(
      (t) => !existingTypes.includes(t.id),
    );
    if (availableType) {
      const models = MODELS[availableType.id];
      setAgents([
        ...agents,
        {
          type: availableType.id,
          model: models[0].id,
          enabled: true,
        },
      ]);
    }
  };

  const removeAgent = (index: number) => {
    setAgents(agents.filter((_, i) => i !== index));
  };

  const updateAgent = (index: number, updates: Partial<AgentConfig>) => {
    const newAgents = [...agents];
    newAgents[index] = { ...newAgents[index], ...updates };
    setAgents(newAgents);
  };

  const enabledAgents = agents.filter((a) => a.enabled);
  const enabledAgentCount = enabledAgents.length;
  const estimatedCost = enabledAgentCount * budget;
  const isRunning = runState === "running";
  const isBusy = isRunning || runState === "confirm";

  async function pollStatus(id: string): Promise<void> {
    // Read through a getter: `pollingRef.current` is flipped asynchronously by
    // the cancel handler during the sleep below, which the type-checker can't
    // see — a direct read would be narrowed and trip `no-unnecessary-condition`.
    const isPolling = () => pollingRef.current;
    while (isPolling()) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!isPolling()) return;
      let data: StatusResponse | null = null;
      try {
        const res = await fetch(`/api/benchmarks/${id}/status`, {
          cache: "no-store",
        });
        if (!res.ok) continue;
        data = (await res.json()) as StatusResponse;
      } catch {
        continue;
      }
      setJobs(data.jobs);
      setLog(data.log);
      if (TERMINAL.has(data.status)) {
        pollingRef.current = false;
        if (data.status === "succeeded") {
          setRunState("success");
          setRunStatus(
            data.dryRun
              ? "Dry run complete — plan validated, nothing spent."
              : "Benchmark run finished. Results written to results/.",
          );
        } else if (data.status === "cancelled") {
          setRunState("error");
          setRunStatus("Run cancelled.");
        } else {
          setRunState("error");
          setRunStatus("Run finished with failures — see the log below.");
        }
        return;
      }
    }
  }

  async function launch(): Promise<void> {
    if (enabledAgentCount === 0) {
      setRunState("error");
      setRunStatus("No agents enabled. Enable at least one agent.");
      return;
    }
    setRunState("running");
    setRunStatus(
      dryRun ? "Starting dry run…" : "Starting live benchmark run…",
    );
    setLog("");
    setJobs([]);

    let data: StartResponse;
    try {
      const res = await fetch("/api/benchmarks/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agents: enabledAgents.map((a) => ({ type: a.type, model: a.model })),
          category: selectedCategory,
          budget,
          timeout: timeoutSecs,
          concurrent,
          dryRun,
        }),
      });
      data = (await res.json()) as StartResponse;
      if (!res.ok || !data.runId) {
        setRunState("error");
        setRunStatus(data.error ?? "Failed to start benchmark run.");
        return;
      }
    } catch (error) {
      setRunState("error");
      setRunStatus(
        `Error: ${error instanceof Error ? error.message : "network failure"}`,
      );
      return;
    }

    setRunId(data.runId);
    setJobs(data.jobs ?? []);
    setRunStatus(data.message ?? "Run started.");
    pollingRef.current = true;
    void pollStatus(data.runId);
  }

  function onStartClick(): void {
    // Live runs spend real money — require an explicit second click.
    if (!dryRun && runState !== "confirm") {
      setRunState("confirm");
      setRunStatus(null);
      return;
    }
    void launch();
  }

  async function cancelRun(): Promise<void> {
    if (!runId) return;
    pollingRef.current = false;
    setRunStatus("Cancelling…");
    try {
      await fetch(`/api/benchmarks/${runId}/cancel`, { method: "POST" });
    } catch {
      // best effort — bench:kill is the backstop
    }
    setRunState("error");
    setRunStatus("Run cancelled.");
  }

  const buttonConfig: { text: string; className: string } = {
    idle: {
      text: dryRun ? "Start Dry Run" : "Start Live Run",
      className:
        "lp-grad-surface text-[#1a1406] shadow-lg hover:scale-[1.02] active:scale-100",
    },
    confirm: {
      text: `Confirm live run — ~$${estimatedCost.toFixed(2)}`,
      className:
        "bg-[var(--color-danger)] text-white shadow-lg hover:brightness-110",
    },
    running: {
      text: "Running…",
      className:
        "bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg animate-pulse",
    },
    success: {
      text: dryRun ? "Start Dry Run" : "Start Live Run",
      className:
        "lp-grad-surface text-[#1a1406] shadow-lg hover:scale-[1.02] active:scale-100",
    },
    error: {
      text: dryRun ? "Start Dry Run" : "Start Live Run",
      className:
        "lp-grad-surface text-[#1a1406] shadow-lg hover:scale-[1.02] active:scale-100",
    },
  }[runState];

  return (
    <div className="space-y-8">
      {/* Agent Configuration */}
      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-lg">🤖</span>
          Agents to compare
        </h3>

        <div className="space-y-3">
          {agents.map((agent, index) => (
            <div
              key={index}
              className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card/60 p-4 transition-colors hover:border-[var(--_ember-flame)]/40"
            >
              <input
                type="checkbox"
                checked={agent.enabled}
                onChange={(e) => {
                  updateAgent(index, { enabled: e.target.checked });
                }}
                className="size-4 accent-[var(--_ember-flame)]"
                disabled={isBusy}
              />

              <select
                value={agent.type}
                onChange={(e) => {
                  updateAgent(index, {
                    type: e.target.value,
                    model: MODELS[e.target.value as keyof typeof MODELS][0].id,
                  });
                }}
                className={`flex-1 ${SELECT_CLASS}`}
                disabled={isBusy}
              >
                {AGENT_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>

              <select
                value={agent.model}
                onChange={(e) => {
                  updateAgent(index, { model: e.target.value });
                }}
                className={`flex-1 ${SELECT_CLASS}`}
                disabled={isBusy}
              >
                {MODELS[agent.type as keyof typeof MODELS].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>

              <div className="text-xs text-muted-foreground">
                {
                  MODELS[agent.type as keyof typeof MODELS].find(
                    (m) => m.id === agent.model,
                  )?.cost
                }
              </div>

              {agents.length > 1 && (
                <button
                  onClick={() => { removeAgent(index); }}
                  disabled={isBusy}
                  className="rounded px-3 py-1 text-sm text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10 disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </div>
          ))}

          {agents.length < AGENT_TYPES.length && (
            <button
              onClick={addAgent}
              disabled={isBusy}
              className="rounded-lg border-2 border-dashed border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-[var(--_ember-flame)]/60 hover:text-foreground disabled:opacity-50"
            >
              + Add agent
            </button>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Comparing <strong className="text-foreground">{enabledAgentCount}</strong>{" "}
          agent{enabledAgentCount !== 1 ? "s" : ""} side-by-side.
        </p>
      </div>

      {/* Task Selection */}
      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-lg">📋</span>
          Tasks
        </h3>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {TASK_CATEGORIES.map((category) => {
            const active = selectedCategory === category.id;
            return (
              <button
                key={category.id}
                onClick={() => { setSelectedCategory(category.id); }}
                disabled={isBusy}
                aria-pressed={active}
                className={`rounded-lg border p-4 text-left transition-all disabled:opacity-50 ${
                  active
                    ? "border-[var(--_ember-flame)]/60 bg-[var(--_ember-flame)]/10 shadow-md"
                    : "border-border bg-card/40 hover:border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center gap-2 font-medium text-foreground">
                  {active && (
                    <span className="size-1.5 rounded-full bg-[var(--_ember-flame)]" />
                  )}
                  {category.name}
                </div>
                <div className="mt-0.5 text-sm text-muted-foreground">
                  {category.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Configuration */}
      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <span className="text-lg">⚙️</span>
          Configuration
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              💰 Budget per agent (USD)
            </label>
            <input
              type="number"
              value={budget}
              onChange={(e) => { setBudget(parseFloat(e.target.value) || 0); }}
              min={1}
              step={1}
              disabled={isBusy}
              className={INPUT_CLASS}
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              ⏱️ Timeout per task (seconds)
            </label>
            <input
              type="number"
              value={timeoutSecs}
              onChange={(e) => { setTimeoutSecs(parseFloat(e.target.value) || 0); }}
              min={60}
              step={60}
              disabled={isBusy}
              className={INPUT_CLASS}
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-foreground">
              🔄 Concurrent tasks
            </label>
            <input
              type="number"
              value={concurrent}
              onChange={(e) => { setConcurrent(parseInt(e.target.value) || 1); }}
              min={1}
              max={10}
              disabled={isBusy}
              className={INPUT_CLASS}
            />
          </div>
        </div>
      </div>

      {/* Dry-run guardrail */}
      <label className="flex items-start gap-3 rounded-lg border border-border bg-card/40 p-4 text-sm">
        <input
          type="checkbox"
          checked={dryRun}
          onChange={(e) => { setDryRun(e.target.checked); }}
          disabled={isBusy}
          className="mt-0.5 size-4 accent-[var(--_ember-flame)]"
        />
        <span>
          <span className="font-medium text-foreground">
            Dry run (plan only — no agents spend)
          </span>
          <span className="mt-0.5 block text-muted-foreground">
            Leave checked to preview the run plan and cost. Uncheck to execute
            the real agents — this spends money and requires confirmation.
          </span>
        </span>
      </label>

      {/* Run Button */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-muted/30 p-6">
        <div>
          <p className="text-lg font-semibold">
            {dryRun ? "Dry run" : "Estimated cost"}
          </p>
          <p className="text-muted-foreground">
            ~${estimatedCost.toFixed(2)} total (
            <strong className="text-foreground">{enabledAgentCount}</strong> agent
            {enabledAgentCount !== 1 ? "s" : ""} × ${budget})
          </p>
        </div>

        <div className="flex items-center gap-3">
          {runState === "confirm" && (
            <button
              onClick={() => {
                setRunState("idle");
                setRunStatus(null);
              }}
              className="rounded-xl border border-border px-5 py-3.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          )}
          {isRunning && (
            <button
              onClick={() => void cancelRun()}
              className="rounded-xl border border-[var(--color-danger)]/50 px-5 py-3.5 text-sm font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10"
            >
              Stop run
            </button>
          )}
          <button
            onClick={onStartClick}
            disabled={isRunning || enabledAgentCount === 0}
            className={`rounded-xl px-8 py-3.5 text-base font-bold transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${buttonConfig.className}`}
          >
            {buttonConfig.text}
          </button>
        </div>
      </div>

      {runState === "confirm" && (
        <div className="animate-fade-in rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-4 text-sm">
          <p className="font-medium text-foreground">
            This is a LIVE run — the selected agents will execute and spend up to
            ~${estimatedCost.toFixed(2)}. Click “Confirm live run” to proceed.
          </p>
        </div>
      )}

      {/* Status + live log */}
      {runStatus && (
        <div
          className={`animate-fade-in rounded-xl border p-4 ${
            runState === "success"
              ? "border-[var(--color-success)]/40 bg-[var(--color-success)]/10"
              : runState === "error"
                ? "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10"
                : "border-[var(--_ember-flame)]/40 bg-[var(--_ember-flame)]/10"
          }`}
        >
          <p className="text-sm font-medium text-foreground">{runStatus}</p>
          {runId && (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Run ID: {runId}
            </p>
          )}
          {jobs.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {jobs.map((job, i) => (
                <span
                  key={`${job.agent}-${i}`}
                  className="rounded-full border border-border bg-card/60 px-2.5 py-1 font-mono text-xs text-muted-foreground"
                >
                  {job.agent}: {job.status}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {log && (
        <pre className="thin-scroll max-h-72 overflow-auto rounded-xl border border-border bg-graphite-950 p-4 font-mono text-xs leading-relaxed text-graphite-300">
          {log}
        </pre>
      )}
    </div>
  );
}

BenchmarkRunner.Skeleton = function BenchmarkRunnerSkeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-6 w-48 rounded bg-muted" />
      <div className="space-y-3">
        <div className="h-20 rounded bg-muted" />
        <div className="h-20 rounded bg-muted" />
      </div>
    </div>
  );
};
