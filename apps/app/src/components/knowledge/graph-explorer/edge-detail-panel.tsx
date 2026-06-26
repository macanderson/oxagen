/**
 * edge-detail-panel.tsx — detail for a selected edge.
 *
 * Edge data is already in memory (source, target, type, inferred flag,
 * confidence), so no fetch is needed. Shows the relationship type, whether it
 * is inferred vs confirmed, the confidence score for inferred edges, and both
 * endpoints with clickable names + copyable ids.
 */

"use client";

import * as React from "react";
import { X, ArrowDown, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableId } from "./copyable-id";
import { ConfidenceMeter } from "./confidence-meter";
import { deleteEdge, type TenantSlugs } from "./api-client";
import type { ExplorerEdge, ExplorerNode } from "./types";
import { colorForLabel } from "./lib/colors";

export interface EdgeDetailPanelProps {
  edge: ExplorerEdge;
  /** Resolved endpoint nodes (for names/labels), keyed lookups done by caller. */
  sourceNode?: ExplorerNode;
  targetNode?: ExplorerNode;
  tenant?: TenantSlugs;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
  onEditEdge?: (edge: ExplorerEdge) => void;
  onDeleteEdge?: (edge: ExplorerEdge) => void;
}

export function EdgeDetailPanel({
  edge,
  sourceNode,
  targetNode,
  tenant,
  onSelectNode,
  onClose,
  onEditEdge,
  onDeleteEdge,
}: EdgeDetailPanelProps) {
  const [deleting, setDeleting] = React.useState(false);

  const handleDelete = async () => {
    if (!tenant) return;
    if (
      !confirm(`Delete the "${edge.type}" relationship? This cannot be undone.`)
    )
      return;
    setDeleting(true);
    try {
      await deleteEdge(tenant, {
        fromNodeId: edge.source,
        toNodeId: edge.target,
        edgeType: edge.type,
      });
      onDeleteEdge?.(edge);
    } catch {
      // Non-fatal
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={edge.inferred ? "secondary" : "outline"} size="sm">
              {edge.inferred ? "Inferred" : "Confirmed"}
            </Badge>
          </div>
          <h2 className="mt-1 break-words font-mono text-sm font-semibold leading-snug text-foreground">
            {edge.type}
          </h2>
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

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {edge.inferred && typeof edge.confidence === "number" && (
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Confidence
            </h3>
            <ConfidenceMeter confidence={edge.confidence} />
          </section>
        )}

        {/* CRUD actions */}
        {(onEditEdge || onDeleteEdge) && !edge.inferred && (
          <div className="flex flex-wrap gap-2">
            {onEditEdge && (
              <Button
                size="sm"
                variant="outline"
                startIcon={<Pencil className="size-3.5" />}
                onClick={() => onEditEdge(edge)}
              >
                Edit
              </Button>
            )}
            {onDeleteEdge && (
              <Button
                size="sm"
                variant="outline"
                startIcon={<Trash2 className="size-3.5" />}
                onClick={handleDelete}
                disabled={deleting}
                className="text-destructive hover:text-destructive"
              >
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            )}
          </div>
        )}

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Endpoints
          </h3>
          <div className="flex flex-col items-stretch gap-2">
            <EndpointRow
              role="Source"
              nodeId={edge.source}
              node={sourceNode}
              onSelect={() => onSelectNode(edge.source)}
            />
            <div
              className="flex justify-center text-muted-foreground"
              aria-hidden="true"
            >
              <ArrowDown className="size-4" />
            </div>
            <EndpointRow
              role="Target"
              nodeId={edge.target}
              node={targetNode}
              onSelect={() => onSelectNode(edge.target)}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function EndpointRow({
  role,
  nodeId,
  node,
  onSelect,
}: {
  role: string;
  nodeId: string;
  node?: ExplorerNode;
  onSelect: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {role}
        </span>
        {node && (
          <Badge variant="outline" size="sm" className="gap-1">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: colorForLabel(node.label) }}
              aria-hidden="true"
            />
            {node.label}
          </Badge>
        )}
      </div>
      <button
        type="button"
        onClick={onSelect}
        className="block w-full truncate text-left text-sm font-medium text-foreground hover:text-primary"
        title={node?.displayName ?? nodeId}
      >
        {node?.displayName ?? nodeId}
      </button>
      <div className="mt-1.5">
        <CopyableId value={nodeId} label="ID" max={22} />
      </div>
    </div>
  );
}
