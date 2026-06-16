"use client";

import * as React from "react";
import { ArrowRight, CheckCircle2, Filter, Circle } from "lucide-react";
import type { SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";

// ── Display helpers ────────────────────────────────────────────────────────────

function confidenceColor(score: number): string {
  if (score >= 0.8) return "text-success";
  if (score >= 0.6) return "text-warning";
  return "text-error";
}

function confidenceDotColor(score: number): string {
  if (score >= 0.8) return "var(--success)";
  if (score >= 0.6) return "var(--warning)";
  return "var(--error)";
}

function formatISO(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── EdgeCard ───────────────────────────────────────────────────────────────────

function EdgeCard({ edge }: { edge: SemanticEdge }) {
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-card px-3.5 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        {/* Relationship diagram */}
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <Circle
            className="h-2 w-2 flex-shrink-0"
            style={{ color: "var(--chart-5)", fill: "var(--chart-5)" }}
            aria-hidden="true"
          />
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {edge.sourceNodeId}
          </span>
          <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <code className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
            {edge.type}
          </code>
          <ArrowRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <Circle
            className="h-2 w-2 flex-shrink-0"
            style={{ color: "var(--chart-3)", fill: "var(--chart-3)" }}
            aria-hidden="true"
          />
          <span className="font-medium text-foreground">{edge.targetNodeId}</span>
        </div>

        {/* Meta */}
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span
            className={`font-semibold tabular-nums ${confidenceColor(edge.confidence)}`}
          >
            {Math.round(edge.confidence * 100)}%
          </span>
          <span>via {edge.source.connectorId}</span>
          {edge.approvedAt && (
            <span className="flex items-center gap-0.5">
              <CheckCircle2 className="h-2.5 w-2.5 text-success" aria-hidden="true" />
              Approved {formatISO(edge.approvedAt)}
            </span>
          )}
        </div>
      </div>

      <Circle
        className="mt-1 h-2.5 w-2.5 flex-shrink-0"
        style={{ color: confidenceDotColor(edge.confidence), fill: confidenceDotColor(edge.confidence) }}
        aria-hidden="true"
      />
    </li>
  );
}

// ── SemanticEdgeViewer ─────────────────────────────────────────────────────────

export interface SemanticEdgeViewerProps {
  /** Approved edges fetched server-side and passed as initial props. */
  edges: SemanticEdge[];
  total: number;
  /** Available relationship types for the type filter dropdown. */
  availableTypes?: string[];
  /** Available connector IDs for the connector filter dropdown. */
  availableConnectors?: string[];
}

/**
 * Read-only browser for approved semantic edges.
 *
 * Renders the edge list in a card grid. Supports client-side filtering by
 * relationship type and connector. Full WebGL Reagraph visualisation is
 * available once `reagraph` is installed; the component renders a placeholder
 * canvas section in its absence.
 */
export function SemanticEdgeViewer({
  edges,
  total,
  availableTypes,
  availableConnectors,
}: SemanticEdgeViewerProps) {
  const [typeFilter, setTypeFilter] = React.useState<string>("");
  const [connectorFilter, setConnectorFilter] = React.useState<string>("");

  const filtered = React.useMemo(() => {
    return edges.filter((e) => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (connectorFilter && e.source.connectorId !== connectorFilter) return false;
      return true;
    });
  }, [edges, typeFilter, connectorFilter]);

  // Derive filter options from edges when not provided.
  const types = availableTypes ?? [...new Set(edges.map((e) => e.type))].sort();
  const connectors = availableConnectors ?? [...new Set(edges.map((e) => e.source.connectorId))].sort();

  if (edges.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-10 text-center">
        <CheckCircle2 className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">No approved edges yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Approved inferred edges appear here. Review pending inferences above to build your
          knowledge graph.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs text-muted-foreground">Filter:</span>

        <select
          aria-label="Filter by relationship type"
          className="rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by connector"
          className="rounded-md border border-border/60 bg-card px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          value={connectorFilter}
          onChange={(e) => setConnectorFilter(e.target.value)}
        >
          <option value="">All connectors</option>
          {connectors.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <span className="ml-auto text-[11px] text-muted-foreground">
          {filtered.length} of {total} edges
        </span>
      </div>

      {/* Edge list */}
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {filtered.map((edge) => (
          <EdgeCard key={edge.id} edge={edge} />
        ))}
      </ul>

      {filtered.length === 0 && (
        <p className="text-center text-xs text-muted-foreground py-4">
          No edges match the current filters.
        </p>
      )}

      {/* Reagraph placeholder — WebGL graph will render here once installed */}
      <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20">
        <div className="flex flex-col items-center gap-2 text-center">
          <ArrowRight className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">Interactive graph visualisation</p>
          <p className="text-xs text-muted-foreground">
            WebGL Reagraph rendering — available once the{" "}
            <code className="font-mono">reagraph</code> package is installed.
          </p>
        </div>
      </div>
    </div>
  );
}
