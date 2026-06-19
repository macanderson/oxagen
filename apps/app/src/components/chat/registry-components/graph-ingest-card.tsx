"use client";
import * as React from "react";
import { resolveRecordHref } from "@oxagen/oxagen/capability-meta";
import { Network, ArrowRight, ArrowUpRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/**
 * graph-ingest-card — renders graph.ingest output: the entities and
 * relationships extracted from text and committed to the knowledge graph, with
 * confidence labels and deep links to each new node's detail page.
 *
 * componentId: "graph-ingest-card"
 */

interface Entity {
  nodeId: string;
  name: string;
  type: string;
  confidence: number;
  created: boolean;
}
interface Relationship {
  from: string;
  to: string;
  edgeType: string;
  confidence: number;
  created: boolean;
}

interface GraphIngestCardProps {
  capability?: string;
  output?: unknown;
  orgSlug?: string;
  workspaceSlug?: string;
}

function readOutput(output: unknown): { entities: Entity[]; relationships: Relationship[]; summary: string } {
  const o = typeof output === "object" && output !== null ? (output as Record<string, unknown>) : {};
  const entities = Array.isArray(o.entities)
    ? o.entities.flatMap((e): Entity[] => {
        if (typeof e !== "object" || e === null) return [];
        const ee = e as Record<string, unknown>;
        if (typeof ee.nodeId !== "string" || typeof ee.name !== "string") return [];
        return [
          {
            nodeId: ee.nodeId,
            name: ee.name,
            type: typeof ee.type === "string" ? ee.type : "Entity",
            confidence: typeof ee.confidence === "number" ? ee.confidence : 0,
            created: ee.created === true,
          },
        ];
      })
    : [];
  const relationships = Array.isArray(o.relationships)
    ? o.relationships.flatMap((r): Relationship[] => {
        if (typeof r !== "object" || r === null) return [];
        const rr = r as Record<string, unknown>;
        if (typeof rr.from !== "string" || typeof rr.to !== "string") return [];
        return [
          {
            from: rr.from,
            to: rr.to,
            edgeType: typeof rr.edgeType === "string" ? rr.edgeType : "RELATED_TO",
            confidence: typeof rr.confidence === "number" ? rr.confidence : 0,
            created: rr.created === true,
          },
        ];
      })
    : [];
  return { entities, relationships, summary: typeof o.summary === "string" ? o.summary : "" };
}

function ConfidenceBadge({ value }: { value: number }): React.ReactElement {
  const pct = Math.round(value * 100);
  const tone = value >= 0.75 ? "text-success" : value >= 0.4 ? "text-warning" : "text-muted-foreground";
  return <span className={cn("shrink-0 text-[10px] tabular-nums", tone)}>{pct}%</span>;
}

export default function GraphIngestCard(props: GraphIngestCardProps): React.ReactElement {
  const { entities, relationships, summary } = readOutput(props.output);
  const slugs = { orgSlug: props.orgSlug, workspaceSlug: props.workspaceSlug };

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="graph-ingest-card"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Network className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">Knowledge graph updated</span>
        <Badge variant="outline" className="ml-auto shrink-0">
          {entities.length} node{entities.length === 1 ? "" : "s"} · {relationships.length} edge
          {relationships.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <div className="space-y-3 px-4 py-3">
        {summary ? <p className="text-sm text-foreground">{summary}</p> : null}

        {entities.length > 0 ? (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Entities
            </div>
            <ul className="space-y-1">
              {entities.slice(0, 30).map((e) => {
                const href = resolveRecordHref("graph.node", e.nodeId, slugs);
                return (
                  <li key={e.nodeId} className="flex items-center gap-2 text-sm">
                    {e.created ? (
                      <Sparkles className="size-3 shrink-0 text-success" aria-label="new" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    {href ? (
                      <a href={href} className="min-w-0 truncate font-medium text-primary hover:underline">
                        {e.name}
                      </a>
                    ) : (
                      <span className="min-w-0 truncate font-medium">{e.name}</span>
                    )}
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {e.type}
                    </Badge>
                    <ConfidenceBadge value={e.confidence} />
                    {href ? (
                      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {relationships.length > 0 ? (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Relationships
            </div>
            <ul className="space-y-1">
              {relationships.slice(0, 30).map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="font-medium">{r.from}</span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <ArrowRight className="size-3" aria-hidden="true" />
                    <span className="font-mono">{r.edgeType}</span>
                    <ArrowRight className="size-3" aria-hidden="true" />
                  </span>
                  <span className="font-medium">{r.to}</span>
                  <ConfidenceBadge value={r.confidence} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {entities.length === 0 && relationships.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entities were extracted from the text.</p>
        ) : null}
      </div>
    </div>
  );
}
