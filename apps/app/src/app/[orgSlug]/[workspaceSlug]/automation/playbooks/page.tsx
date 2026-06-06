/**
 * page.tsx — Workspace → Automation → Playbooks (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: automation.playbooks.list + automation.playbooks.create
 *                 capabilities (workspace_playbooks table, Postgres).
 *
 * Playbooks are versioned, parameterised agent plans. Each has a JSON schema
 * for its parameters and optional approval requirements per step.
 */
import {
  Info,
  BookMarked,
  Plus,
  CheckCircle2,
  PauseCircle,
  GitBranch,
  Tag,
  Calendar,
  MoreHorizontal,
  ShieldCheck,
} from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type PlaybookStatus = "published" | "draft" | "archived";

interface MockPlaybook {
  id: string;
  name: string;
  description: string;
  status: PlaybookStatus;
  version: string;
  stepCount: number;
  requiresApproval: boolean;
  lastRunAt: string | null;
  runCount: number;
  tags: string[];
  createdAt: string;
}

const MOCK_PLAYBOOKS: MockPlaybook[] = [
  {
    id: "pb-01",
    name: "Monthly knowledge graph audit",
    description: "Validates entity freshness, removes stale nodes older than 90 days, and generates a reconciliation report.",
    status: "published",
    version: "1.2.0",
    stepCount: 5,
    requiresApproval: true,
    lastRunAt: "2026-06-01 09:00",
    runCount: 3,
    tags: ["knowledge-graph", "maintenance"],
    createdAt: "2026-05-01",
  },
  {
    id: "pb-02",
    name: "New source onboarding",
    description: "Provisions a new data source, runs initial sync, validates record ingestion, and sends a Slack summary.",
    status: "published",
    version: "2.0.1",
    stepCount: 8,
    requiresApproval: false,
    lastRunAt: "2026-06-05 14:30",
    runCount: 7,
    tags: ["connectors", "ingestion"],
    createdAt: "2026-05-10",
  },
  {
    id: "pb-03",
    name: "Competitor analysis weekly",
    description: "Researches 5 configured competitor URLs, extracts pricing and feature changes, and produces a delta report.",
    status: "draft",
    version: "0.3.0",
    stepCount: 4,
    requiresApproval: false,
    lastRunAt: null,
    runCount: 0,
    tags: ["research"],
    createdAt: "2026-06-04",
  },
  {
    id: "pb-04",
    name: "Billing anomaly investigation",
    description: "Cross-references ClickHouse token events against Stripe invoices and flags discrepancies above $10.",
    status: "published",
    version: "1.0.0",
    stepCount: 6,
    requiresApproval: true,
    lastRunAt: "2026-05-28 08:00",
    runCount: 2,
    tags: ["billing", "reliability"],
    createdAt: "2026-05-20",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<PlaybookStatus, { icon: React.ElementType; badgeClass: string; label: string }> = {
  published: {
    icon: CheckCircle2,
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    label: "Published",
  },
  draft: {
    icon: PauseCircle,
    badgeClass: "bg-muted text-muted-foreground",
    label: "Draft",
  },
  archived: {
    icon: BookMarked,
    badgeClass: "bg-muted text-muted-foreground",
    label: "Archived",
  },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function PlaybookCard({ pb }: { pb: MockPlaybook }) {
  const status = STATUS_CONFIG[pb.status];
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{pb.name}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.badgeClass}`}>
              {status.label}
            </span>
            {pb.requiresApproval && (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300">
                <ShieldCheck className="h-2.5 w-2.5" aria-hidden="true" />
                Approval required
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{pb.description}</p>
        </div>
        <button
          type="button"
          aria-label="More options"
          className="flex-shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted transition-colors"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <GitBranch className="h-3 w-3" aria-hidden="true" />
          v{pb.version} · {pb.stepCount} steps
        </span>
        <span className="flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          {pb.runCount} runs
        </span>
        {pb.lastRunAt && (
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" aria-hidden="true" />
            Last run {pb.lastRunAt}
          </span>
        )}
      </div>

      {/* Tags */}
      {pb.tags.length > 0 && (
        <div className="flex items-center gap-1.5">
          <Tag className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          <div className="flex gap-1">
            {pb.tags.map((tag) => (
              <span
                key={tag}
                className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AutomationPlaybooksPage() {
  const publishedCount = MOCK_PLAYBOOKS.filter((p) => p.status === "published").length;

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
          <BookMarked className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Playbooks</p>
            <p className="text-xs text-muted-foreground">
              Author, version, and manage playbooks. Set parameter schemas and configure approval
              requirements. {publishedCount} of {MOCK_PLAYBOOKS.length} published.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New playbook
        </button>
      </div>

      {/* Playbook cards */}
      <div className="flex flex-col gap-3">
        {MOCK_PLAYBOOKS.map((pb) => (
          <PlaybookCard key={pb.id} pb={pb} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Playbooks are available via the API and MCP surfaces today.
        In-app playbook builder coming soon.
      </p>
    </div>
  );
}
