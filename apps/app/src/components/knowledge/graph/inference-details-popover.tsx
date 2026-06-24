/**
 * inference-details-popover.tsx — the "Details" affordance for a pending
 * inferred edge.
 *
 * Clicking Details opens a popover that fully describes the relationship: the
 * relationship type + confidence + its own properties (model, connector, when
 * it was inferred, status), and BOTH endpoints cited by their human label with
 * their complete property bags. No raw UUID is ever the primary identifier —
 * ids are available, copyable, inside each node section.
 */

"use client";

import * as React from "react";
import { ArrowRight, Eye } from "lucide-react";
import type { KnowledgeNodeRef, SemanticEdge } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { CopyableId } from "../graph-explorer/copyable-id";
import { ConfidenceMeter } from "../graph-explorer/confidence-meter";
import { PropertyList } from "../graph-explorer/property-list";
import { colorForLabel } from "../graph-explorer/lib/colors";
import { sourceNodeRef, targetNodeRef } from "./node-ref";

// Relationship properties shown structurally above the list (type as the
// header, confidence as the meter) — omit them from the property list.
const OMITTED_RELATIONSHIP_KEYS = ["relationshipType", "confidence"];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

function NodeSection({ title, node }: { title: string; node: KnowledgeNodeRef }) {
  const displayName = node.displayName?.trim() || node.label || node.id || "Unknown node";
  const properties = node.properties ?? {};
  return (
    <section className="border-t border-border/40 px-4 py-3">
      <SectionTitle>{title}</SectionTitle>
      <div className="flex items-start gap-2">
        <span
          className="mt-1 size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: colorForLabel(node.label) }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <Badge variant="outline" size="sm">
            {node.label}
          </Badge>
          <p className="mt-1 break-words text-sm font-semibold text-foreground">{displayName}</p>
          {node.id ? (
            <div className="mt-1.5">
              <CopyableId value={node.id} label="ID" max={28} />
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Candidate — materialises in the graph when the edge is approved.
            </p>
          )}
        </div>
      </div>
      <div className="mt-2.5">
        <PropertyList
          properties={properties}
          omit={["displayName", "name", "publicId", "label", "id"]}
          dense
        />
      </div>
    </section>
  );
}

export interface InferenceDetailsPopoverProps {
  edge: SemanticEdge;
}

/**
 * Encapsulates the Details button (the popover trigger) so the pending list just
 * renders `<InferenceDetailsPopover edge={edge} />`.
 */
export function InferenceDetailsPopover({ edge }: InferenceDetailsPopoverProps) {
  const source = sourceNodeRef(edge);
  const target = targetNodeRef(edge);
  const relProps: Record<string, unknown> =
    edge.relationshipProperties ?? {
      relationshipType: edge.type,
      confidence: edge.confidence,
      inferredAt: edge.inferredAt,
    };

  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        aria-label="View relationship details"
      >
        <Eye className="h-3 w-3" aria-hidden="true" />
        Details
      </PopoverTrigger>
      <PopoverPopup
        side="bottom"
        align="end"
        className="w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden p-0"
      >
        {/* Header */}
        <header className="border-b border-border/40 px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">Relationship details</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Inferred candidate — approve to materialise it permanently.
          </p>
        </header>

        {/* Relationship */}
        <section className="px-4 py-3">
          <SectionTitle>Relationship</SectionTitle>
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-sm">
            <NodeMini node={source} />
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
              {edge.type}
            </code>
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <NodeMini node={target} />
          </div>
          <div className="mb-2.5">
            <ConfidenceMeter confidence={edge.confidence} />
          </div>
          <PropertyList properties={relProps} omit={OMITTED_RELATIONSHIP_KEYS} dense />
        </section>

        <div className="max-h-[40vh] overflow-y-auto">
          <NodeSection title="Start node" node={source} />
          <NodeSection title="End node" node={target} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Compact inline node label (dot + name) used in the relationship diagram. */
function NodeMini({ node }: { node: KnowledgeNodeRef }) {
  const displayName = node.displayName?.trim() || node.label || node.id || "Unknown";
  return (
    <span className="inline-flex min-w-0 items-center gap-1" title={displayName}>
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colorForLabel(node.label) }}
        aria-hidden="true"
      />
      <span className="truncate font-medium text-foreground">{displayName}</span>
    </span>
  );
}
