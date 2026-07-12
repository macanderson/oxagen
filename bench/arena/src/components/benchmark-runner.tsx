/**
 * Benchmark Runner Component
 *
 * GUI for configuring and running benchmarks with multiple agents.
 * Enhanced with animated button, better UX, and live progress display.
 */

"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { LiveProgressDisplay } from "./benchmark-progress-live";

// Agent type definitions
const AGENT_TYPES = [
  { id: "oxagen", name: "Oxagen", description: "The Stripe-for-agents platform" },
  { id: "stella", name: "Stella", description: "Open-source CLI coding agent" },
  { id: "claude-code", name: "Claude Code", description: "Anthropic's official CLI" }
] as const;

const MODELS = {
  oxagen: [
    { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", cost: "$0.008/1K in, $0.024/1K out" },
    { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", cost: "$0.03/1K in, $0.15/1K out" },
    { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8", cost: "$0.15/1K in, $0.75/1K out" }
  ],
  stella: [
    { id: "glm-4-flash", name: "GLM-4 Flash", cost: "~$0.001/1K tokens" },
    { id: "glm-4-plus", name: "GLM-4 Plus", cost: "~$0.01/1K tokens" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini", cost: "~$0.15/1K in, $0.60/1K out" }
  ],
  "claude-code": [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", cost: "$0.03/1K in, $0.15/1K out" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8", cost: "$0.15/1K in, $0.75/1K out" }
  ]
} as const;

const TASK_CATEGORIES = [
  { id: "smoke", name: "Smoke Tests", description: "Quick validation tasks", color: "bg-blue-50 border-blue-200 hover:bg-blue-100" },
  { id: "bug-fix", name: "Bug Fixes", description: "Fix reported issues", color: "bg-red-50 border-red-200 hover:bg-red-100" },
  { id: "feature-implementation", name: "Feature Implementation", description: "Add new functionality", color: "bg-green-50 border-green-200 hover:bg-green-100" },
  { id: "refactoring", name: "Refactoring", description: "Improve code structure", color: "bg-purple-50 border-purple-200 hover:bg-purple-100" },
  { id: "testing", name: "Testing", description: "Write tests", color: "bg-amber-50 border-amber-200 hover:bg-amber-100" }
] as const;

interface AgentConfig {
  type: string;
  model: string;
  enabled: boolean;
}

type RunState = "idle" | "running" | "success" | "error";

export function BenchmarkRunner() {
  const [agents, setAgents] = useState<AgentConfig[]>([
    { type: "oxagen", model: "anthropic/claude-sonnet-5", enabled: true }
  ]);
  const [selectedCategory, setSelectedCategory] = useState("smoke");
  const [budget, setBudget] = useState(25);
  const [timeoutSecs, setTimeoutSecs] = useState(600);
  const [concurrent, setConcurrent] = useState(1);
  const [runState, setRunState] = useState<RunState>("idle");
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const addAgent = () => {
    const existingTypes = agents.map(a => a.type);
    const availableType = AGENT_TYPES.find(t => !existingTypes.includes(t.id));
    if (availableType) {
      const models = MODELS[availableType.id as keyof typeof MODELS];
      setAgents([...agents, {
        type: availableType.id,
        model: models[0]?.id || "",
        enabled: true
      }]);
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

  const startBenchmark = async () => {
    setRunState("running");
    setRunStatus("Initializing benchmark run...");

    try {
      // Collect enabled agents
      const enabledAgents = agents.filter(a => a.enabled);

      if (enabledAgents.length === 0) {
        setRunState("error");
        setRunStatus("❌ No agents enabled. Please enable at least one agent.");
        return;
      }

      // Call the start benchmark API
      const response = await fetch("/api/benchmarks/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agents: enabledAgents.map(a => ({ type: a.type, model: a.model })),
          taskCategory: selectedCategory,
          budget,
          timeout: timeoutSecs,
          concurrent
        })
      });

      if (!response.ok) {
        throw new Error("Failed to start benchmark");
      }

      const data = await response.json();
      const newRunId = data.runId;
      setRunId(newRunId);
      setRunStatus(`✅ Benchmark started! Run ID: ${newRunId}`);

      // Don't reset - keep showing progress
    } catch (error) {
      setRunState("error");
      setRunStatus(`❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const handleProgressComplete = (results: any[]) => {
    setRunState("success");
    setRunStatus(`✅ Benchmark completed! ${results.length} tasks finished.`);
  };

  const enabledAgentCount = agents.filter(a => a.enabled).length;
  const estimatedCost = enabledAgentCount * budget;

  const buttonConfig = {
    idle: {
      text: "🚀 Start Benchmark",
      className: "bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-lg hover:shadow-xl",
      icon: null
    },
    running: {
      text: "⚡ Running...",
      className: "bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg animate-pulse",
      icon: "⏳"
    },
    success: {
      text: "✅ Started!",
      className: "bg-gradient-to-r from-green-600 to-emerald-600 text-white shadow-lg",
      icon: "✓"
    },
    error: {
      text: "❌ Failed",
      className: "bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-lg",
      icon: "✗"
    }
  }[runState];

  return (
    <div className="space-y-6">
      {/* Agent Configuration */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <span className="text-2xl">🤖</span>
          Agents to Compare
        </h3>

        <div className="space-y-3">
          {agents.map((agent, index) => (
            <div key={index} className="flex items-center gap-4 p-4 border-2 rounded-lg hover:border-primary/50 transition-colors bg-card">
              <input
                type="checkbox"
                checked={agent.enabled}
                onChange={e => updateAgent(index, { enabled: e.target.checked })}
                className="w-5 h-5 text-primary"
                disabled={runState === "running"}
              />

              <select
                value={agent.type}
                onChange={e => updateAgent(index, { type: e.target.value, model: MODELS[e.target.value as keyof typeof MODELS]?.[0]?.id || "" })}
                className="flex-1 max-w-xs px-3 py-2 border rounded-lg bg-background"
                disabled={runState === "running"}
              >
                {AGENT_TYPES.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>

              <select
                value={agent.model}
                onChange={e => updateAgent(index, { model: e.target.value })}
                className="flex-1 max-w-sm px-3 py-2 border rounded-lg bg-background"
                disabled={runState === "running"}
              >
                {MODELS[agent.type as keyof typeof MODELS]?.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>

              <div className="text-xs text-muted-foreground">
                {MODELS[agent.type as keyof typeof MODELS]?.find(m => m.id === agent.model)?.cost}
              </div>

              {agents.length > 1 && (
                <button
                  onClick={() => removeAgent(index)}
                  disabled={runState === "running"}
                  className="px-3 py-1 text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Remove
                </button>
              )}
            </div>
          ))}

          {agents.length < AGENT_TYPES.length && (
            <button
              onClick={addAgent}
              disabled={runState === "running"}
              className="px-4 py-2 text-sm border-2 border-dashed rounded-lg hover:border-primary hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + Add Agent
            </button>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          📊 Comparing <strong>{enabledAgentCount}</strong> agent{enabledAgentCount !== 1 ? "s" : ""} side-by-side
        </p>
      </div>

      {/* Task Selection */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <span className="text-2xl">📋</span>
          Tasks
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {TASK_CATEGORIES.map(category => (
            <button
              key={category.id}
              onClick={() => setSelectedCategory(category.id)}
              disabled={runState === "running"}
              className={`p-4 border-2 rounded-lg text-left transition-all ${
                selectedCategory === category.id
                  ? `${category.color} border-primary scale-105 shadow-md`
                  : "border-border hover:bg-muted/50"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <div className="font-medium">{category.name}</div>
              <div className="text-sm text-muted-foreground">{category.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Configuration */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <span className="text-2xl">⚙️</span>
          Configuration
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium">💰 Budget per Agent (USD)</label>
            <input
              type="number"
              value={budget}
              onChange={e => setBudget(parseFloat(e.target.value) || 0)}
              min={1}
              step={1}
              disabled={runState === "running"}
              className="w-full px-3 py-2 border rounded-lg bg-background"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium">⏱️ Timeout per Task (seconds)</label>
            <input
              type="number"
              value={timeoutSecs}
              onChange={e => setTimeout(parseFloat(e.target.value) || 0)}
              min={60}
              step={60}
              disabled={runState === "running"}
              className="w-full px-3 py-2 border rounded-lg bg-background"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium">🔄 Concurrent Tasks</label>
            <input
              type="number"
              value={concurrent}
              onChange={e => setConcurrent(parseInt(e.target.value) || 1)}
              min={1}
              max={10}
              disabled={runState === "running"}
              className="w-full px-3 py-2 border rounded-lg bg-background"
            />
          </div>
        </div>
      </div>

      {/* Run Button */}
      <div className="flex items-center justify-between p-6 bg-gradient-to-r from-muted/50 to-muted/30 rounded-xl border-2 border-border">
        <div>
          <p className="font-medium text-lg">💵 Estimated Cost</p>
          <p className="text-muted-foreground">
            ~${estimatedCost.toFixed(2)} total (<strong>{enabledAgentCount}</strong> agent{enabledAgentCount !== 1 ? "s" : ""} × ${budget})
          </p>
        </div>

        <button
          onClick={startBenchmark}
          disabled={runState === "running" || enabledAgentCount === 0}
          className={`px-8 py-4 rounded-xl font-bold text-lg transition-all duration-300 transform hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none ${buttonConfig.className}`}
        >
          {buttonConfig.icon && <span className="mr-2">{buttonConfig.icon}</span>}
          {buttonConfig.text}
        </button>
      </div>

      {/* Status */}
      {runStatus && !runId && (
        <div className={`p-4 rounded-xl border-2 animate-fade-in ${
          runState === "success" ? "bg-green-50 border-green-200" :
          runState === "error" ? "bg-red-50 border-red-200" :
          "bg-blue-50 border-blue-200"
        }`}>
          <p className="text-sm font-medium">{runStatus}</p>
        </div>
      )}

      {/* Live Progress Display */}
      {runId && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <LiveProgressDisplay
            runId={runId}
            onComplete={handleProgressComplete}
            className="p-6 bg-gradient-to-br from-slate-50 to-slate-100 rounded-xl border-2 border-slate-200"
          />

          <div className="mt-4 flex gap-3">
            <button
              onClick={() => {
                setRunId(null);
                setRunState("idle");
                setRunStatus(null);
              }}
              className="px-4 py-2 bg-white border-2 border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Close Progress
            </button>
            <button
              onClick={() => window.open(`/results/${runId}`, '_blank')}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              View Full Results
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

BenchmarkRunner.Skeleton = function BenchmarkRunnerSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-6 bg-muted rounded w-48" />
      <div className="space-y-3">
        <div className="h-20 bg-muted rounded" />
        <div className="h-20 bg-muted rounded" />
      </div>
    </div>
  );
};
