/**
 * page.tsx — Workspace → Activity → Runs (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: activity.runs.list (ClickHouse) — streaming runs feed with
 *                 status, duration, token cost, and a link to the conversation.
 */
import { Info, Play, CheckCircle2, XCircle, Clock, Loader2, Cpu, Coins } from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type RunStatus = "completed" | "failed" | "running" | "cancelled";

interface MockRun {
  id: string;
  conversationId: string;
  title: string;
  status: RunStatus;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  startedAt: string;
  surface: "app" | "api" | "mcp";
  toolCallCount: number;
}

const MOCK_RUNS: MockRun[] = [
  {
    id: "run-001",
    conversationId: "conv-abc",
    title: "Summarise Q2 investor report and extract key metrics",
    status: "completed",
    model: "Claude Sonnet 4.6",
    inputTokens: 24_580,
    outputTokens: 1_204,
    durationMs: 8_320,
    startedAt: "2026-06-06 14:32",
    surface: "app",
    toolCallCount: 3,
  },
  {
    id: "run-002",
    conversationId: "conv-def",
    title: "Generate hero image — Campaign Q2 brand kit",
    status: "completed",
    model: "GPT Image 1",
    inputTokens: 512,
    outputTokens: 0,
    durationMs: 12_100,
    startedAt: "2026-06-06 13:21",
    surface: "app",
    toolCallCount: 1,
  },
  {
    id: "run-003",
    conversationId: "conv-ghi",
    title: "Ingest GitHub issues and update knowledge graph",
    status: "running",
    model: "Claude Haiku 4.5",
    inputTokens: 8_200,
    outputTokens: 340,
    durationMs: 0,
    startedAt: "2026-06-06 14:55",
    surface: "api",
    toolCallCount: 12,
  },
  {
    id: "run-004",
    conversationId: "conv-jkl",
    title: "Competitive pricing analysis across 5 vendors",
    status: "failed",
    model: "Claude Opus 4.8",
    inputTokens: 52_000,
    outputTokens: 420,
    durationMs: 45_200,
    startedAt: "2026-06-06 12:10",
    surface: "mcp",
    toolCallCount: 8,
  },
  {
    id: "run-005",
    conversationId: "conv-mno",
    title: "Draft onboarding email sequence for Build plan users",
    status: "completed",
    model: "Claude Sonnet 4.6",
    inputTokens: 6_800,
    outputTokens: 3_400,
    durationMs: 22_400,
    startedAt: "2026-06-05 17:45",
    surface: "app",
    toolCallCount: 0,
  },
  {
    id: "run-006",
    conversationId: "conv-pqr",
    title: "Audit workspace knowledge graph for stale nodes",
    status: "cancelled",
    model: "Claude Sonnet 4.6",
    inputTokens: 1_200,
    outputTokens: 80,
    durationMs: 3_100,
    startedAt: "2026-06-05 11:30",
    surface: "app",
    toolCallCount: 2,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const STATUS_CONFIG: Record<RunStatus, { label: string; icon: React.ElementType; className: string }> = {
  completed: {
    label: "Completed",
    icon: CheckCircle2,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    className: "text-red-500 dark:text-red-400",
  },
  running: {
    label: "Running",
    icon: Loader2,
    className: "text-blue-500 dark:text-blue-400 animate-spin",
  },
  cancelled: {
    label: "Cancelled",
    icon: XCircle,
    className: "text-muted-foreground",
  },
};

const SURFACE_BADGE: Record<MockRun["surface"], string> = {
  app: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  api: "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  mcp: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function RunRow({ run }: { run: MockRun }) {
  const status = STATUS_CONFIG[run.status];
  const StatusIcon = status.icon;
  return (
    <li className="flex flex-col gap-1.5 border-b border-border/40 px-4 py-4 last:border-b-0 hover:bg-muted/30 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <StatusIcon
            className={`mt-0.5 h-4 w-4 flex-shrink-0 ${status.className}`}
            aria-label={status.label}
          />
          <span className="text-sm font-medium text-foreground line-clamp-1">{run.title}</span>
        </div>
        <span
          className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SURFACE_BADGE[run.surface]}`}
        >
          {run.surface}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 pl-6 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Cpu className="h-3 w-3" aria-hidden="true" />
          {run.model}
        </span>
        <span className="flex items-center gap-1">
          <Coins className="h-3 w-3" aria-hidden="true" />
          {formatTokens(run.inputTokens + run.outputTokens)} tokens
        </span>
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" aria-hidden="true" />
          {formatDuration(run.durationMs)}
        </span>
        {run.toolCallCount > 0 && (
          <span className="flex items-center gap-1">
            <Play className="h-3 w-3" aria-hidden="true" />
            {run.toolCallCount} tool {run.toolCallCount === 1 ? "call" : "calls"}
          </span>
        )}
        <span>{run.startedAt}</span>
      </div>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ActivityRunsPage() {
  const completedCount = MOCK_RUNS.filter((r) => r.status === "completed").length;
  const failedCount = MOCK_RUNS.filter((r) => r.status === "failed").length;
  const totalTokens = MOCK_RUNS.reduce(
    (sum, r) => sum + r.inputTokens + r.outputTokens,
    0,
  );

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Completed (24h)</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{completedCount}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Failed (24h)</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{failedCount}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Tokens used (24h)</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{(totalTokens / 1000).toFixed(1)}K</span>
        </div>
      </div>

      {/* Runs list */}
      <div className="rounded-lg border border-border/60">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <Play className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground">Recent runs</span>
          <span className="ml-auto text-xs text-muted-foreground">Last 24 hours</span>
        </div>
        <ul>
          {MOCK_RUNS.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">
        Runs are retained for 90 days on Build plan, 1 year on Scale and Enterprise.
        Detailed token costs appear in Billing → Usage.
      </p>
    </div>
  );
}
