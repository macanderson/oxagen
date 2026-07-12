/**
 * Live Benchmark Progress Display
 *
 * Beautiful, animated real-time progress tracking for benchmark runs.
 * Features motion animations, live updates, and a modern sexy UI.
 */

"use client";

import { useEffect, useState } from "react";
import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
  AnimatePresence,
} from "motion/react";

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkProgressState {
  runId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  totalTasks: number;
  completedTasks: number;
  currentTask?: {
    id: string;
    name: string;
    agent: string;
    model: string;
    status: "running" | "completed" | "failed";
    progress: number; // 0-100
    tokensUsed: number;
    costSoFar: number;
    duration: number;
  };
  results: Array<{
    taskId: string;
    taskName: string;
    agent: string;
    model: string;
    success: boolean;
    duration: number;
    cost: number;
    tokens: number;
  }>;
  totalCost: number;
  totalTokens: number;
  errors: string[];
}

export interface LiveProgressDisplayProps {
  runId: string;
  pollInterval?: number;
  onComplete?: (results: BenchmarkProgressState["results"]) => void;
  className?: string;
}

// ============================================================================
// Utility Components
// ============================================================================

interface ProgressBarProps {
  progress: number; // 0-100
  color?: string;
  height?: number;
  showPercentage?: boolean;
  animated?: boolean;
  className?: string;
}

function ProgressBar({
  progress,
  color = "hsl(142, 76%, 36%)",
  height = 8,
  showPercentage = true,
  animated = true,
  className = "",
}: ProgressBarProps) {
  const width = useMotionValue(`${progress}%`);
  const animatedWidth = useSpring(width, {
    bounce: 0,
    duration: 0.8,
  });

  useEffect(() => {
    if (animated) {
      width.set(`${progress}%`);
    }
  }, [progress, animated, width]);

  return (
    <div className={`w-full bg-gray-200 rounded-full overflow-hidden relative ${className}`}>
      <div
        className="h-full rounded-full relative overflow-hidden"
        style={{ height: `${height}px` }}
      >
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            backgroundColor: color,
            width: animated ? animatedWidth : `${progress}%`,
          }}
        />
        {animated && (
          <motion.div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
            animate={{
              x: ["-100%", "100%"],
            }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              ease: "linear",
            }}
          />
        )}
      </div>
      {showPercentage && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-bold text-white mix-blend-difference">
            {progress.toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
}

interface TaskStatusIndicatorProps {
  status: "pending" | "running" | "completed" | "failed";
  size?: "sm" | "md" | "lg";
  className?: string;
}

function TaskStatusIndicator({
  status,
  size = "md",
  className = "",
}: TaskStatusIndicatorProps) {
  const sizeMap = {
    sm: 12,
    md: 16,
    lg: 24,
  };

  const sizePx = sizeMap[size];

  const variants = {
    pending: {
      bg: "bg-gray-300",
      icon: null,
    },
    running: {
      bg: "bg-blue-500",
      icon: (
        <motion.span
          animate={{ rotate: 360 }}
          transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
        >
          ⚡
        </motion.span>
      ),
    },
    completed: {
      bg: "bg-green-500",
      icon: "✓",
    },
    failed: {
      bg: "bg-red-500",
      icon: "✕",
    },
  };

  const config = variants[status];

  return (
    <motion.div
      className={`flex items-center justify-center rounded-full ${config.bg} ${className}`}
      style={{ width: sizePx, height: sizePx }}
      initial={{ scale: 0 }}
      animate={{ scale: 1 }}
      transition={{ type: "spring", bounce: 0.5 }}
    >
      {config.icon && (
        <span className="text-white text-xs" style={{ fontSize: sizePx * 0.6 }}>
          {config.icon}
        </span>
      )}
    </motion.div>
  );
}

interface MetricCardProps {
  label: string;
  value: string | number;
  icon: string;
  color?: string;
  trend?: "up" | "down" | "neutral";
  className?: string;
}

function MetricCard({
  label,
  value,
  icon,
  color = "from-blue-500 to-blue-600",
  className = "",
}: MetricCardProps) {
  return (
    <motion.div
      className={`relative overflow-hidden rounded-xl p-4 bg-gradient-to-br ${color} ${className}`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="absolute inset-0 bg-white/10 backdrop-blur-sm" />
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-2">
          <span className="text-white/80 text-sm font-medium">{label}</span>
          <span className="text-2xl">{icon}</span>
        </div>
        <motion.div
          className="text-3xl font-bold text-white"
          initial={{ scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", bounce: 0.3 }}
        >
          {value}
        </motion.div>
      </div>
    </motion.div>
  );
}

interface TaskRowProps {
  taskName: string;
  agent: string;
  status: "pending" | "running" | "completed" | "failed";
  duration?: number;
  cost?: number;
  progress?: number;
  index: number;
}

function TaskRow({
  taskName,
  agent,
  status,
  duration,
  cost,
  progress,
  index,
}: TaskRowProps) {
  return (
    <motion.div
      className="flex items-center gap-4 p-3 rounded-lg bg-white/50 hover:bg-white/70 transition-colors"
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.5) }}
    >
      <TaskStatusIndicator status={status} />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{taskName}</div>
        <div className="text-xs text-gray-500">{agent}</div>
      </div>
      {status === "running" && progress !== undefined && (
        <div className="w-24">
          <ProgressBar progress={progress} height={4} showPercentage={false} />
        </div>
      )}
      {status === "completed" && duration !== undefined && (
        <div className="text-sm font-medium text-green-600">
          {duration.toFixed(1)}s
        </div>
      )}
      {status === "completed" && cost !== undefined && (
        <div className="text-xs text-gray-500">${cost.toFixed(3)}</div>
      )}
      {status === "failed" && (
        <div className="text-xs text-red-500 font-medium">Failed</div>
      )}
    </motion.div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function LiveProgressDisplay({
  runId,
  pollInterval = 1000,
  onComplete,
  className = "",
}: LiveProgressDisplayProps) {
  const [state, setState] = useState<BenchmarkProgressState>({
    runId,
    status: "queued",
    startTime: Date.now(),
    totalTasks: 0,
    completedTasks: 0,
    results: [],
    totalCost: 0,
    totalTokens: 0,
    errors: [],
  });

  const [currentTime, setCurrentTime] = useState(Date.now());

  // Poll for updates
  useEffect(() => {
    const poll = async () => {
      try {
        const response = await fetch(`/api/benchmarks/progress/${runId}`);
        if (response.ok) {
          const data = await response.json();
          setState(data);

          if (data.status === "completed" || data.status === "failed") {
            onComplete?.(data.results);
          }
        }
      } catch (error) {
        console.error("Failed to poll progress:", error);
      }
    };

    poll();
    const interval = setInterval(poll, pollInterval);
    return () => clearInterval(interval);
  }, [runId, pollInterval, onComplete]);

  // Update current time for duration calculations
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);

  const elapsed = ((state.endTime || currentTime) - state.startTime) / 1000;
  const progress = (state.completedTasks / state.totalTasks) * 100 || 0;
  const estimatedTimeRemaining =
    state.completedTasks > 0
      ? (elapsed / state.completedTasks) *
          (state.totalTasks - state.completedTasks)
      : 0;

  // Status badge
  const statusBadge = {
    queued: { text: "Queued", color: "bg-yellow-100 text-yellow-800" },
    running: { text: "Running", color: "bg-blue-100 text-blue-800" },
    completed: { text: "Completed", color: "bg-green-100 text-green-800" },
    failed: { text: "Failed", color: "bg-red-100 text-red-800" },
    cancelled: { text: "Cancelled", color: "bg-gray-100 text-gray-800" },
  }[state.status];

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header */}
      <motion.div
        className="flex items-center justify-between"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div>
          <h2 className="text-2xl font-bold">Benchmark Progress</h2>
          <p className="text-gray-500 text-sm">Run ID: {runId}</p>
        </div>
        <motion.span
          className={`px-4 py-2 rounded-full text-sm font-medium ${statusBadge.color}`}
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          {statusBadge.text}
        </motion.span>
      </motion.div>

      {/* Overall Progress */}
      <motion.div
        className="space-y-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.1 }}
      >
        <div className="flex justify-between text-sm">
          <span className="font-medium">
            {state.completedTasks} / {state.totalTasks} tasks
          </span>
          <span className="text-gray-500">
            {state.status === "running" && estimatedTimeRemaining > 0
              ? `~${Math.ceil(estimatedTimeRemaining)}s remaining`
              : `${elapsed.toFixed(1)}s elapsed`}
          </span>
        </div>
        <ProgressBar progress={progress} height={12} animated />
      </motion.div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          label="Total Cost"
          value={`$${state.totalCost.toFixed(2)}`}
          icon="💰"
          color="from-emerald-500 to-emerald-600"
        />
        <MetricCard
          label="Tokens Used"
          value={(state.totalTokens / 1000).toFixed(1) + "k"}
          icon="🔥"
          color="from-orange-500 to-orange-600"
        />
        <MetricCard
          label="Success Rate"
          value={
            state.completedTasks > 0
              ? (
                  (state.results.filter((r) => r.success).length /
                    state.completedTasks) *
                  100
                ).toFixed(0) + "%"
              : "-"
          }
          icon="✓"
          color="from-blue-500 to-blue-600"
        />
        <MetricCard
          label="Avg Duration"
          value={
            state.completedTasks > 0
              ? (
                  state.results.reduce((sum, r) => sum + r.duration, 0) /
                  state.completedTasks
                ).toFixed(1) + "s"
              : "-"
          }
          icon="⏱️"
          color="from-purple-500 to-purple-600"
        />
      </div>

      {/* Current Task */}
      <AnimatePresence>
        {state.currentTask && state.status === "running" && (
          <motion.div
            className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-4 border border-blue-100 shadow-sm"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="flex items-center gap-2 mb-3">
              <motion.span
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="text-xl"
              >
                ⚡
              </motion.span>
              <span className="font-semibold">Currently Running</span>
            </div>
            <div className="space-y-2">
              <div className="font-medium">{state.currentTask.name}</div>
              <div className="text-sm text-gray-600">
                {state.currentTask.agent} · {state.currentTask.model}
              </div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gray-500">Progress:</span>{" "}
                  {state.currentTask.progress.toFixed(0)}%
                </div>
                <div>
                  <span className="text-gray-500">Tokens:</span>{" "}
                  {state.currentTask.tokensUsed.toLocaleString()}
                </div>
                <div>
                  <span className="text-gray-500">Cost:</span> $
                  {state.currentTask.costSoFar.toFixed(3)}
                </div>
              </div>
              <ProgressBar progress={state.currentTask.progress} height={6} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Task List */}
      <motion.div
        className="space-y-2"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
      >
        <h3 className="font-semibold text-sm">Tasks</h3>
        <div className="space-y-1 max-h-96 overflow-y-auto pr-2">
          {state.results.map((result, index) => (
            <TaskRow
              key={result.taskId}
              taskName={result.taskName}
              agent={`${result.agent} (${result.model})`}
              status={result.success ? "completed" : "failed"}
              duration={result.duration}
              cost={result.cost}
              index={index}
            />
          ))}
          {state.currentTask && (
            <TaskRow
              taskName={state.currentTask.name}
              agent={`${state.currentTask.agent} (${state.currentTask.model})`}
              status="running"
              progress={state.currentTask.progress}
              index={state.results.length}
            />
          )}
          {Array.from({
            length: Math.max(
              0,
              state.totalTasks - state.completedTasks - (state.currentTask ? 1 : 0)
            ),
          }).map((_, i) => (
            <TaskRow
              key={`pending-${i}`}
              taskName="Pending task..."
              agent=""
              status="pending"
              index={state.results.length + (state.currentTask ? 1 : 0) + i}
            />
          ))}
        </div>
      </motion.div>

      {/* Errors */}
      <AnimatePresence>
        {state.errors.length > 0 && (
          <motion.div
            className="bg-red-50 border border-red-200 rounded-lg p-4"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <h4 className="font-semibold text-red-800 mb-2">Errors</h4>
            <ul className="space-y-1">
              {state.errors.map((error, i) => (
                <li key={i} className="text-sm text-red-700">
                  • {error}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
