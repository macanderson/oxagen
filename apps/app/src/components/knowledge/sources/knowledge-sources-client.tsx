"use client";

import * as React from "react";

const API_BASE = "/api";
import {
  Database,
  Plus,
  CheckCircle2,
  AlertTriangle,
  Clock,
  RefreshCw,
  GithubIcon,
  MoreHorizontal,
  Settings2,
  Trash2,
} from "lucide-react";
import { GitHubConnectionWizard } from "./github-connection-wizard";
import {
  EditSourceConfigSheet,
  type EditSourceTarget,
} from "./edit-source-config-sheet";
import {
  DeleteSourceDialog,
  type DeleteSourceTarget,
} from "./delete-source-dialog";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
} from "@/components/ui/menu";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";

type Connection = ConnectionListOutput["connections"][number];

// ── Display helpers ────────────────────────────────────────────────────────────

const CONNECTOR_DISPLAY_NAMES: Record<string, string> = {
  github: "GitHub",
  linear: "Linear",
  google_drive: "Google Drive",
  notion: "Notion",
  slack: "Slack",
  confluence: "Confluence",
  jira: "Jira",
  salesforce: "Salesforce",
};

const CONNECTOR_ICONS: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  github: GithubIcon,
};

interface StatusConfig {
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  className: string;
  iconClassName?: string;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  // "connected" is what the DB stores for a live, healthy connection.
  connected: {
    label: "Connected",
    icon: CheckCircle2,
    className: "text-success",
  },
  // "active" kept for backwards-compat in case any older record uses it.
  active: {
    label: "Synced",
    icon: CheckCircle2,
    className: "text-success",
  },
  syncing: {
    label: "Syncing…",
    icon: RefreshCw,
    className: "text-info",
    iconClassName: "animate-spin",
  },
  in_progress: {
    label: "Syncing…",
    icon: RefreshCw,
    className: "text-info",
    iconClassName: "animate-pulse",
  },
  error: {
    label: "Error",
    icon: AlertTriangle,
    className: "text-error",
  },
  has_errors: {
    label: "Has Errors",
    icon: AlertTriangle,
    className: "text-error",
  },
  needs_reauth: {
    label: "Needs Reconnect",
    icon: AlertTriangle,
    className: "text-warning",
  },
  pending_setup: {
    label: "Pending Setup",
    icon: Clock,
    className: "text-muted-foreground",
  },
  pending: {
    label: "Pending",
    icon: Clock,
    className: "text-muted-foreground",
  },
  paused: {
    label: "Paused",
    icon: Clock,
    className: "text-muted-foreground",
  },
};

function getStatusConfig(status: string): StatusConfig {
  return STATUS_CONFIG[status] ?? {
    label: status,
    icon: Clock,
    className: "text-muted-foreground",
  };
}

function formatCount(n: number): string {
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface ConnectionRowProps {
  connection: Connection;
  onResyncStart: (connectionId: string) => void;
  onEdit: (connection: Connection) => void;
  onDelete: (connection: Connection) => void;
  resyncing: Set<string>;
}

function ConnectionRow({ connection, onResyncStart, onEdit, onDelete, resyncing }: ConnectionRowProps) {
  const statusConfig = getStatusConfig(connection.status);
  const StatusIcon = statusConfig.icon;
  const ConnectorIcon = CONNECTOR_ICONS[connection.connectorId] ?? Database;
  const displayName = CONNECTOR_DISPLAY_NAMES[connection.connectorId] ?? connection.connectorId;
  const formattedDate = formatDate(connection.lastSyncAt);
  const isSyncing = resyncing.has(connection.publicId);

  return (
    <li
      className="flex items-start justify-between gap-4 border-b border-border/40 px-4 py-4 last:border-b-0"
      data-testid={`connection-row-${connection.publicId}`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/60">
          <ConnectorIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{connection.displayName}</span>
            <span className="text-[11px] text-muted-foreground">via {displayName}</span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span
              className={`flex items-center gap-1 font-medium ${isSyncing ? "text-info" : statusConfig.className}`}
              data-testid={`connection-status-${connection.publicId}`}
            >
              {isSyncing ? (
                <>
                  <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
                  Syncing…
                </>
              ) : (
                <>
                  <StatusIcon className={`h-3 w-3 ${statusConfig.iconClassName ?? ""}`} aria-hidden="true" />
                  {statusConfig.label}
                </>
              )}
            </span>
            {connection.entityCount > 0 && (
              <span className="text-muted-foreground">
                {formatCount(connection.entityCount)} records
              </span>
            )}
            {formattedDate && (
              <span className="text-muted-foreground">Last synced {formattedDate}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {(connection.status === "connected" || connection.status === "active" || connection.status === "paused" || connection.status === "error" || connection.status === "has_errors") && (
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-border/60 bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            disabled={isSyncing}
            onClick={() => onResyncStart(connection.publicId)}
            data-testid={`resync-btn-${connection.publicId}`}
          >
            <RefreshCw className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} aria-hidden="true" />
            Re-sync
          </button>
        )}
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
            data-testid={`source-menu-trigger-${connection.publicId}`}
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Source actions</span>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() => onEdit(connection)}
              data-testid={`edit-source-${connection.publicId}`}
            >
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              Edit configuration
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={() => onDelete(connection)}
              className="text-destructive data-[highlighted]:text-destructive"
              data-testid={`delete-source-${connection.publicId}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Delete source
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
}

// ── Empty State ────────────────────────────────────────────────────────────────

interface EmptyStateProps {
  onConnect: () => void;
}

function EmptyState({ onConnect }: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-12 text-center"
      data-testid="connections-empty-state"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Database className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">No sources connected</p>
        <p className="text-xs text-muted-foreground max-w-xs">
          Connect a data source to give your agents access to your code, docs, and project data.
        </p>
      </div>
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        onClick={onConnect}
        data-testid="connect-github-btn"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Connect GitHub
      </button>
    </div>
  );
}

// ── Main client component ──────────────────────────────────────────────────────

export interface KnowledgeSourcesClientProps {
  connections: ConnectionListOutput["connections"];
  orgSlug: string;
  workspaceSlug: string;
  /** Set when the OAuth callback redirected back here with ?setup=github */
  setupConnector?: string;
  /** Set when the OAuth callback redirected back here with ?connectionId=X */
  setupConnectionId?: string;
}

export function KnowledgeSourcesClient({
  connections,
  orgSlug,
  workspaceSlug,
  setupConnector,
  setupConnectionId,
}: KnowledgeSourcesClientProps) {
  const [wizardOpen, setWizardOpen] = React.useState(
    setupConnector === "github",
  );
  const [resyncing, setResyncing] = React.useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = React.useState<Connection | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Connection | null>(null);

  const activeConnections = connections.filter((c) => c.status !== "deleted");
  const syncedCount = activeConnections.filter((c) => c.status === "connected" || c.status === "active").length;
  const totalRecords = activeConnections.reduce((s, c) => s + c.entityCount, 0);

  // Stable derived targets — memoized on the selected connection's identity so
  // the sheet/dialog effects don't refetch on unrelated re-renders.
  const editTargetProp = React.useMemo<EditSourceTarget | null>(
    () =>
      editTarget
        ? {
            publicId: editTarget.publicId,
            connectorId: editTarget.connectorId,
            displayName: editTarget.displayName,
          }
        : null,
    [editTarget],
  );
  const deleteTargetProp = React.useMemo<DeleteSourceTarget | null>(
    () =>
      deleteTarget
        ? {
            publicId: deleteTarget.publicId,
            displayName: deleteTarget.displayName,
            entityCount: deleteTarget.entityCount,
          }
        : null,
    [deleteTarget],
  );

  const handleResync = React.useCallback(
    async (publicId: string) => {
      setResyncing((prev) => new Set([...prev, publicId]));
      try {
        const res = await fetch(
          `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/${publicId}/resync`,
          { method: "POST", credentials: "include" },
        );
        if (!res.ok) {
          console.error("Resync failed:", await res.text());
        }
      } catch (e) {
        console.error("Resync error:", e);
      } finally {
        // Keep the "syncing" indicator visible briefly so the user sees feedback.
        // The page doesn't auto-refresh — user can reload to see updated status.
        setTimeout(() => {
          setResyncing((prev) => {
            const next = new Set(prev);
            next.delete(publicId);
            return next;
          });
        }, 3_000);
      }
    },
    [orgSlug, workspaceSlug],
  );

  return (
    <>
      {/* Header actions row */}
      <div className="flex items-center justify-between">
        {activeConnections.length > 0 && (
          <div className="grid grid-cols-3 gap-3 flex-1">
            <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
              <span className="text-xs text-muted-foreground">Sources</span>
              <span className="text-xl font-semibold tabular-nums text-foreground">
                {activeConnections.length}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
              <span className="text-xs text-muted-foreground">Synced</span>
              <span className="text-xl font-semibold tabular-nums text-foreground">
                {syncedCount}
              </span>
            </div>
            <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
              <span className="text-xs text-muted-foreground">Total records</span>
              <span className="text-xl font-semibold tabular-nums text-foreground">
                {formatCount(totalRecords)}
              </span>
            </div>
          </div>
        )}
        {activeConnections.length > 0 && (
          <button
            type="button"
            className="ml-3 flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            onClick={() => setWizardOpen(true)}
            data-testid="connect-source-btn"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Connect source
          </button>
        )}
      </div>

      {/* Connection list or empty state */}
      {activeConnections.length === 0 ? (
        <EmptyState onConnect={() => setWizardOpen(true)} />
      ) : (
        <div className="rounded-lg border border-border/60">
          <ul>
            {activeConnections.map((connection) => (
              <ConnectionRow
                key={connection.publicId}
                connection={connection}
                onResyncStart={handleResync}
                onEdit={setEditTarget}
                onDelete={setDeleteTarget}
                resyncing={resyncing}
              />
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Connected sources are synced either a set schedule or via inbound webhooks. 
        Manual sync is available per-source. Information ingested from sources is
        searchable by all agents in this workspace.
      </p>

      <GitHubConnectionWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        initialConnectionId={setupConnector === "github" ? setupConnectionId : undefined}
      />

      <EditSourceConfigSheet
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        target={editTargetProp}
      />

      <DeleteSourceDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        target={deleteTargetProp}
      />
    </>
  );
}
