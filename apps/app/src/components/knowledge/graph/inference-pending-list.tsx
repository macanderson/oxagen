"use client";

import * as React from "react";
import { ArrowRight, CheckCircle2, XCircle, Eye, RefreshCw, Layers } from "lucide-react";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";

// ── Display helpers ────────────────────────────────────────────────────────────

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

function confidenceColor(score: number): string {
  if (score >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 0.6) return "text-amber-500 dark:text-amber-400";
  return "text-red-500 dark:text-red-400";
}

function formatConfidence(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// ── InferredEdgeRow ────────────────────────────────────────────────────────────

interface InferredEdgeRowProps {
  edge: SemanticEdge;
  orgSlug: string;
  workspaceSlug: string;
  onAction: (edgeId: string, decision: "approve" | "reject") => void;
  onSelect: (edge: SemanticEdge) => void;
  processing: Set<string>;
}

function InferredEdgeRow({
  edge,
  onAction,
  onSelect,
  processing,
}: InferredEdgeRowProps) {
  const isProcessing = processing.has(edge.id);

  return (
    <li className="flex items-start justify-between gap-4 border-b border-border/40 px-4 py-3 last:border-b-0">
      {/* Edge summary */}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-3 text-left hover:opacity-80 transition-opacity"
        onClick={() => onSelect(edge)}
        aria-label={`View edge from ${edge.sourceNodeId} to ${edge.targetNodeId}`}
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="truncate font-mono text-xs text-muted-foreground">{edge.sourceNodeId}</span>
            <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
              {edge.type}
            </code>
            <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium text-foreground">{edge.targetNodeId}</span>
            <span className="text-[11px] text-muted-foreground">({edge.source.connectorId})</span>
          </div>
          <span
            className={`text-[11px] font-semibold tabular-nums ${confidenceColor(edge.confidence)}`}
          >
            {formatConfidence(edge.confidence)} confidence
          </span>
        </div>
      </button>

      {/* Actions */}
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted transition-colors"
          onClick={() => onSelect(edge)}
          disabled={isProcessing}
          aria-label="View edge details"
        >
          <Eye className="h-3 w-3" aria-hidden="true" />
          Details
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400 dark:hover:bg-emerald-950/60 transition-colors disabled:opacity-50"
          onClick={() => onAction(edge.id, "approve")}
          disabled={isProcessing}
          aria-label={`Approve edge ${edge.id}`}
        >
          {isProcessing ? (
            <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          )}
          Approve
        </button>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60 transition-colors disabled:opacity-50"
          onClick={() => onAction(edge.id, "reject")}
          disabled={isProcessing}
          aria-label={`Reject edge ${edge.id}`}
        >
          {isProcessing ? (
            <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <XCircle className="h-3 w-3" aria-hidden="true" />
          )}
          Reject
        </button>
      </div>
    </li>
  );
}

// ── BulkActionBar ──────────────────────────────────────────────────────────────

interface BulkActionBarProps {
  total: number;
  connectorId: string;
  onBulkApprove: (connectorId: string) => void;
  bulkApproving: boolean;
}

function BulkActionBar({ total, connectorId, onBulkApprove, bulkApproving }: BulkActionBarProps) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-muted/30 border-b border-border/40">
      <span className="text-[11px] text-muted-foreground">
        {total} pending from <span className="font-semibold text-foreground">{connectorId}</span>
      </span>
      <button
        type="button"
        className="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-400 dark:hover:bg-emerald-950/60 transition-colors disabled:opacity-50"
        onClick={() => onBulkApprove(connectorId)}
        disabled={bulkApproving}
      >
        {bulkApproving ? (
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        )}
        Approve all from {connectorId}
      </button>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export interface InferencePendingListProps {
  orgSlug: string;
  workspaceSlug: string;
  /** Initial suggestions to render; parent may refresh on mutation. */
  initialSuggestions: SemanticEdge[];
  /** Total matching count from the API response. */
  total: number;
  onSelectEdge?: (edge: SemanticEdge) => void;
}

export function InferencePendingList({
  orgSlug,
  workspaceSlug,
  initialSuggestions,
  total,
  onSelectEdge,
}: InferencePendingListProps) {
  const [suggestions, setSuggestions] = React.useState<SemanticEdge[]>(initialSuggestions);
  const [processing, setProcessing] = React.useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);

  // Synchronise if parent refreshes the list.
  React.useEffect(() => {
    setSuggestions(initialSuggestions);
  }, [initialSuggestions]);

  const handleAction = React.useCallback(
    async (edgeId: string, decision: "approve" | "reject") => {
      setProcessing((p) => new Set([...p, edgeId]));
      setError(null);
      try {
        const res = await fetch(
          `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/semantic-edges/${edgeId}/decide`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ decision }),
          },
        );
        if (!res.ok) {
          const msg = (await res.text()) || res.statusText;
          throw new Error(`Failed to ${decision} edge: ${msg}`);
        }
        // Remove from local list on success.
        setSuggestions((prev) => prev.filter((e) => e.id !== edgeId));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setProcessing((p) => {
          const next = new Set(p);
          next.delete(edgeId);
          return next;
        });
      }
    },
    [orgSlug, workspaceSlug],
  );

  const handleBulkApprove = React.useCallback(
    async (connectorId: string) => {
      const toApprove = suggestions.filter((e) => e.source.connectorId === connectorId);
      if (toApprove.length === 0) return;

      setBulkApproving((p) => new Set([...p, connectorId]));
      setError(null);
      try {
        await Promise.all(toApprove.map((e) => handleAction(e.id, "approve")));
      } finally {
        setBulkApproving((p) => {
          const next = new Set(p);
          next.delete(connectorId);
          return next;
        });
      }
    },
    [suggestions, handleAction],
  );

  // Group suggestions by connector.
  const byConnector = React.useMemo(() => {
    const groups = new Map<string, SemanticEdge[]>();
    for (const s of suggestions) {
      const key = s.source.connectorId;
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }
    return groups;
  }, [suggestions]);

  if (suggestions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-10 text-center">
        <Layers className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">No pending inferences</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Inferred edges will appear here after a sync. Trigger a sync from the Sources tab, then
          return here to review.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400"
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{total}</span> pending inferences
          {suggestions.length < total && ` — showing ${suggestions.length}`}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/60">
        {[...byConnector.entries()].map(([connectorId, edges]) => (
          <div key={connectorId}>
            <BulkActionBar
              total={edges.length}
              connectorId={connectorId}
              onBulkApprove={handleBulkApprove}
              bulkApproving={bulkApproving.has(connectorId)}
            />
            <ul>
              {edges.map((edge) => (
                <InferredEdgeRow
                  key={edge.id}
                  edge={edge}
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                  onAction={handleAction}
                  onSelect={(e) => onSelectEdge?.(e)}
                  processing={processing}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
