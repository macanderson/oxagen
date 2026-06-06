/**
 * page.tsx — Workspace → Knowledge → Sources (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: knowledge.sources.list + knowledge.sources.create
 *                 capabilities (workspace_sources / mcp_servers table, Postgres).
 *
 * Shows authenticated data connections and ingest pipeline status.
 */
import {
  Info,
  Database,
  Plus,
  CheckCircle2,
  AlertTriangle,
  Clock,
  RefreshCw,
  GithubIcon,
  TrelloIcon,
  FileText,
  Layers,
} from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type SourceStatus = "synced" | "syncing" | "error" | "pending";

interface MockSource {
  id: string;
  name: string;
  connector: string;
  status: SourceStatus;
  lastSyncAt: string | null;
  recordCount: number;
  errorMessage: string | null;
  connectedAt: string;
}

const MOCK_SOURCES: MockSource[] = [
  {
    id: "src-01",
    name: "oxagen-monorepo",
    connector: "GitHub",
    status: "synced",
    lastSyncAt: "2026-06-06 14:00",
    recordCount: 4_820,
    errorMessage: null,
    connectedAt: "2026-05-15",
  },
  {
    id: "src-02",
    name: "oxagen-v2 (Linear)",
    connector: "Linear",
    status: "syncing",
    lastSyncAt: "2026-06-06 13:30",
    recordCount: 312,
    errorMessage: null,
    connectedAt: "2026-05-20",
  },
  {
    id: "src-03",
    name: "Product Specs",
    connector: "Google Drive",
    status: "error",
    lastSyncAt: "2026-06-05 22:00",
    recordCount: 148,
    errorMessage: "OAuth token expired — reconnect required",
    connectedAt: "2026-05-28",
  },
  {
    id: "src-04",
    name: "Notion Wiki",
    connector: "Notion",
    status: "pending",
    lastSyncAt: null,
    recordCount: 0,
    errorMessage: null,
    connectedAt: "2026-06-06",
  },
];

const CONNECTOR_ICONS: Record<string, React.ElementType> = {
  GitHub: GithubIcon,
  Linear: TrelloIcon,
  "Google Drive": FileText,
  Notion: Layers,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<SourceStatus, { label: string; icon: React.ElementType; className: string }> = {
  synced: {
    label: "Synced",
    icon: CheckCircle2,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  syncing: {
    label: "Syncing…",
    icon: RefreshCw,
    className: "text-blue-500 dark:text-blue-400 animate-spin",
  },
  error: {
    label: "Error",
    icon: AlertTriangle,
    className: "text-red-500 dark:text-red-400",
  },
  pending: {
    label: "Pending",
    icon: Clock,
    className: "text-muted-foreground",
  },
};

function formatCount(n: number): string {
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SourceRow({ source }: { source: MockSource }) {
  const status = STATUS_CONFIG[source.status];
  const StatusIcon = status.icon;
  const ConnectorIcon = CONNECTOR_ICONS[source.connector] ?? Database;
  return (
    <li className="flex items-start justify-between gap-4 border-b border-border/40 px-4 py-4 last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/60">
          <ConnectorIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{source.name}</span>
            <span className="text-[11px] text-muted-foreground">via {source.connector}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`flex items-center gap-1 font-medium ${status.className}`}>
              <StatusIcon className="h-3 w-3" aria-hidden="true" />
              {status.label}
            </span>
            {source.recordCount > 0 && (
              <span className="text-muted-foreground">
                {formatCount(source.recordCount)} records
              </span>
            )}
            {source.lastSyncAt && (
              <span className="text-muted-foreground">Last synced {source.lastSyncAt}</span>
            )}
          </div>
          {source.errorMessage && (
            <p className="text-[11px] text-red-500 dark:text-red-400">{source.errorMessage}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        className="flex-shrink-0 rounded-md border border-border/60 bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
      >
        {source.status === "error" ? "Reconnect" : "Manage"}
      </button>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function KnowledgeSourcesPage() {
  const totalRecords = MOCK_SOURCES.reduce((s, src) => s + src.recordCount, 0);
  const syncedCount = MOCK_SOURCES.filter((s) => s.status === "synced").length;

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
          <Database className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Sources</p>
            <p className="text-xs text-muted-foreground">
              Authenticated data connections and ingest pipelines. Connect a source and your
              agents gain access to the data within their knowledge graph.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Connect source
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Sources</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{MOCK_SOURCES.length}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Synced</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{syncedCount}</span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Total records</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">{formatCount(totalRecords)}</span>
        </div>
      </div>

      {/* Sources list */}
      <div className="rounded-lg border border-border/60">
        <ul>
          {MOCK_SOURCES.map((source) => (
            <SourceRow key={source.id} source={source} />
          ))}
        </ul>
      </div>

      <p className="text-xs text-muted-foreground">
        Connected sources are synced on a schedule. Manual sync is available per-source.
        Records ingested from sources are searchable by all agents in this workspace.
      </p>
    </div>
  );
}

