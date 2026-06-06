/**
 * page.tsx — Workspace → Automation → Agents (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: automation.agents.list + automation.agents.create
 *                 capabilities (workspace_agents table, Postgres).
 *
 * Each agent is a principal with its own capability grants and a model tier.
 */
import {
  Info,
  Bot,
  Plus,
  CheckCircle2,
  PauseCircle,
  Activity,
  Key,
  Cpu,
  MoreHorizontal,
} from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type AgentStatus = "active" | "paused" | "draft";

interface MockAgent {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  modelTier: "fast" | "balanced" | "precise";
  capabilityCount: number;
  runCount: number;
  lastRunAt: string | null;
  createdAt: string;
}

const MOCK_AGENTS: MockAgent[] = [
  {
    id: "agt-01",
    name: "Data Ingestion Agent",
    description: "Syncs connected sources into the knowledge graph on a schedule. Reads-only — no write capabilities beyond knowledge graph ingestion.",
    status: "active",
    modelTier: "fast",
    capabilityCount: 8,
    runCount: 142,
    lastRunAt: "2026-06-06 14:00",
    createdAt: "2026-05-15",
  },
  {
    id: "agt-02",
    name: "Research Agent",
    description: "Performs deep research tasks across connected sources and the web. Configured with require-approval for any external API calls.",
    status: "active",
    modelTier: "precise",
    capabilityCount: 12,
    runCount: 34,
    lastRunAt: "2026-06-05 10:35",
    createdAt: "2026-05-20",
  },
  {
    id: "agt-03",
    name: "Billing Audit Agent",
    description: "Validates credit usage, reconciles Stripe events against ClickHouse telemetry, and flags anomalies.",
    status: "paused",
    modelTier: "balanced",
    capabilityCount: 6,
    runCount: 18,
    lastRunAt: "2026-06-04 09:00",
    createdAt: "2026-06-01",
  },
  {
    id: "agt-04",
    name: "Content Draft Agent",
    description: "Generates first-draft content in Studio using the active brand kit. Writes to Studio Library only.",
    status: "draft",
    modelTier: "balanced",
    capabilityCount: 4,
    runCount: 0,
    lastRunAt: null,
    createdAt: "2026-06-06",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<AgentStatus, { icon: React.ElementType; className: string; badgeClass: string; label: string }> = {
  active: {
    icon: CheckCircle2,
    className: "text-emerald-600 dark:text-emerald-400",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    label: "Active",
  },
  paused: {
    icon: PauseCircle,
    className: "text-amber-500 dark:text-amber-400",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    label: "Paused",
  },
  draft: {
    icon: Bot,
    className: "text-muted-foreground",
    badgeClass: "bg-muted text-muted-foreground",
    label: "Draft",
  },
};

const TIER_LABELS: Record<MockAgent["modelTier"], string> = {
  fast: "Oxagen Fast",
  balanced: "Oxagen Balanced",
  precise: "Oxagen Precise",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function AgentCard({ agent }: { agent: MockAgent }) {
  const status = STATUS_CONFIG[agent.status];
  const StatusIcon = status.icon;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-4 py-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/60">
            <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{agent.name}</span>
              <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.badgeClass}`}>
                <StatusIcon className={`h-3 w-3 ${status.className}`} aria-hidden="true" />
                {status.label}
              </span>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{agent.description}</p>
          </div>
        </div>
        <button
          type="button"
          aria-label="More options"
          className="flex-shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap items-center gap-3 pl-11 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Cpu className="h-3 w-3" aria-hidden="true" />
          {TIER_LABELS[agent.modelTier]}
        </span>
        <span className="flex items-center gap-1">
          <Key className="h-3 w-3" aria-hidden="true" />
          {agent.capabilityCount} capabilities
        </span>
        <span className="flex items-center gap-1">
          <Activity className="h-3 w-3" aria-hidden="true" />
          {agent.runCount} runs
        </span>
        {agent.lastRunAt && <span>Last run {agent.lastRunAt}</span>}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AutomationAgentsPage() {
  const activeCount = MOCK_AGENTS.filter((a) => a.status === "active").length;

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Bot className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Agents</p>
            <p className="text-xs text-muted-foreground">
              Agent configurations and principal assignments. Each agent is a principal with its
              own capability grants. {activeCount} of {MOCK_AGENTS.length} agents active.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New agent
        </button>
      </div>

      {/* Agent cards */}
      <div className="flex flex-col gap-3">
        {MOCK_AGENTS.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Agents are available via the API and MCP surfaces today.
        In-app agent builder coming soon.
      </p>
    </div>
  );
}
