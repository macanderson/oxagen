/**
 * node-detail-panel.tsx — full detail for a selected node.
 *
 * Lazily fetches the node's properties (`graph.node.get`) and its directly
 * connected neighbors (`ontology.neighbors`) when the selection changes. Shows
 * the human label + display name up top, a copyable id, the full property list,
 * and a clickable list of related entities grouped by relationship.
 */

"use client";

import * as React from "react";
import { Loader2, X, Boxes, ArrowRight, ArrowLeft, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableId } from "./copyable-id";
import { PropertyList } from "./property-list";
import { fetchNodeDetail, type TenantSlugs } from "./api-client";
import type { ExplorerNeighbor, ExplorerNode } from "./types";
import { colorForLabel } from "./lib/colors";

export interface NodeDetailPanelProps {
  tenant: TenantSlugs;
  nodeId: string;
  /** Fallback header data while detail loads (from the in-view node). */
  fallback?: Pick<ExplorerNode, "label" | "displayName">;
  onSelectNode: (nodeId: string) => void;
  onExpand: (nodeId: string) => void;
  onClose: () => void;
}

interface DetailState {
  status: "loading" | "ready" | "error";
  node: ExplorerNode | null;
  neighbors: ExplorerNeighbor[];
}

export function NodeDetailPanel({
  tenant,
  nodeId,
  fallback,
  onSelectNode,
  onExpand,
  onClose,
}: NodeDetailPanelProps) {
  const [state, setState] = React.useState<DetailState>({
    status: "loading",
    node: null,
    neighbors: [],
  });

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ status: "loading", node: null, neighbors: [] });
    fetchNodeDetail(tenant, nodeId, controller.signal)
      .then((payload) => {
        if (!active) return;
        setState({
          status: "ready",
          node: payload.node,
          neighbors: payload.neighbors,
        });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setState({ status: "error", node: null, neighbors: [] });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [tenant, nodeId]);

  const label = state.node?.label ?? fallback?.label ?? "Node";
  const displayName =
    state.node?.displayName ?? fallback?.displayName ?? nodeId;

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        label={label}
        displayName={displayName}
        nodeId={nodeId}
        onClose={onClose}
      />

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            startIcon={<Plus className="size-3.5" />}
            onClick={() => onExpand(nodeId)}
          >
            Expand neighbours
          </Button>
        </div>

        <section>
          <SectionTitle>Properties</SectionTitle>
          {state.status === "loading" ? (
            <PanelSpinner label="Loading properties" />
          ) : state.status === "error" ? (
            <p className="text-xs text-destructive">
              Failed to load node detail.
            </p>
          ) : (
            <PropertyList
              properties={state.node?.properties ?? {}}
              omit={["displayName", "publicId"]}
            />
          )}
        </section>

        <section>
          <SectionTitle>
            Related entities
            {state.neighbors.length > 0 && (
              <Badge variant="muted" size="sm" className="ml-2">
                {state.neighbors.length}
              </Badge>
            )}
          </SectionTitle>
          {state.status === "loading" ? (
            <PanelSpinner label="Loading relationships" />
          ) : state.neighbors.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No connected entities.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {state.neighbors.map((n) => (
                <NeighborRow
                  key={`${n.nodeId}:${n.edgeType}:${n.direction}`}
                  neighbor={n}
                  onSelect={() => onSelectNode(n.nodeId)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function DetailHeader({
  label,
  displayName,
  nodeId,
  onClose,
}: {
  label: string;
  displayName: string;
  nodeId: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border px-4 py-3">
      <span
        className="mt-1 size-3 shrink-0 rounded-full"
        style={{ backgroundColor: colorForLabel(label) }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="sm">
            {label}
          </Badge>
        </div>
        <h2 className="mt-1 break-words text-sm font-semibold leading-snug text-foreground">
          {displayName}
        </h2>
        <div className="mt-1.5">
          <CopyableId value={nodeId} label="ID" max={22} />
        </div>
      </div>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Close detail"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function NeighborRow({
  neighbor,
  onSelect,
}: {
  neighbor: ExplorerNeighbor;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
      >
        {neighbor.direction === "out" ? (
          <ArrowRight
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="outgoing"
          />
        ) : (
          <ArrowLeft
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="incoming"
          />
        )}
        <Boxes
          className="size-3.5 shrink-0"
          style={{ color: colorForLabel(neighbor.label) }}
          aria-hidden="true"
        />
        <span
          className="min-w-0 flex-1 truncate text-foreground"
          title={neighbor.displayName}
        >
          {neighbor.displayName}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {neighbor.edgeType}
        </span>
      </button>
    </li>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function PanelSpinner({ label }: { label: string }) {
  return (
    <div
      className={cn("flex items-center gap-2 text-xs text-muted-foreground")}
    >
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      {label}…
    </div>
  );
}
