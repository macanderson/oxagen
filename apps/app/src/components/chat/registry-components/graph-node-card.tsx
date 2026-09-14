"use client";
import * as React from "react";
import { Network, ArrowUpRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";
import { TruncatedText } from "@/components/ui/truncated-text";

/**
 * graph-node-card — renders a single KnowledgeNode from graph.node.get or
 * graph.node.upsert, deep-linked to its detail page. Reads the uniform render
 * envelope: links[] carries the pre-resolved node href.
 *
 * componentId: "graph-node-card"
 */

interface ResultRecordLink {
  field: string;
  recordType: string;
  id: string;
  href: string | null;
  label: string;
}

interface GraphNodeCardProps {
  capability?: string;
  output?: unknown;
  links?: ResultRecordLink[];
  title?: string;
}

interface NodeShape {
  nodeId?: string;
  label?: string;
  displayName?: string;
  description?: string | null;
  properties?: Record<string, unknown> | null;
  created?: boolean;
}

function readNode(output: unknown): NodeShape {
  if (typeof output !== "object" || output === null) return {};
  const o = output as Record<string, unknown>;
  // graph.node.get → { node: {...} }; graph.node.upsert → { nodeId, created }.
  const node = (o.node ?? o) as Record<string, unknown>;
  return {
    nodeId: typeof node.nodeId === "string" ? node.nodeId : undefined,
    label: typeof node.label === "string" ? node.label : undefined,
    displayName:
      typeof node.displayName === "string" ? node.displayName : undefined,
    description: typeof node.description === "string" ? node.description : null,
    properties:
      typeof node.properties === "object" && node.properties !== null
        ? (node.properties as Record<string, unknown>)
        : null,
    created: typeof o.created === "boolean" ? o.created : undefined,
  };
}

export default function GraphNodeCard(
  props: GraphNodeCardProps,
): React.ReactElement {
  const node = readNode(props.output);
  // `links[].href` is capability output — a model-influenced string — so the
  // scheme is allow-listed before it reaches the DOM. An unsafe value yields
  // no link rather than a `javascript:` navigation. Matches capability-result.
  const href = props.links?.map((l) => safeHref(l.href)).find(Boolean) ?? null;
  const heading = props.title ?? node.displayName ?? "Knowledge node";
  const propEntries = node.properties
    ? Object.entries(node.properties).slice(0, 12)
    : [];

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="graph-node-card"
      data-node-id={node.nodeId}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Network className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate text-sm font-semibold" title={heading}>
          {heading}
        </span>
        {node.label ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {node.label}
          </span>
        ) : null}
        {node.created === true ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-success">
            <Sparkles className="size-3" aria-hidden="true" /> New
          </span>
        ) : null}
      </div>

      <div className="space-y-3 px-4 py-3">
        {node.description ? (
          <p className="text-sm text-foreground">
            <TruncatedText text={node.description} lines={2} />
          </p>
        ) : null}

        {propEntries.length > 0 ? (
          <dl className="grid gap-x-4 gap-y-1 overflow-x-auto sm:grid-cols-[minmax(6rem,auto)_1fr]">
            {propEntries.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="text-xs font-medium text-muted-foreground">
                  {k}
                </dt>
                <dd className="min-w-0 break-words text-sm">
                  <TruncatedText text={String(v)} lines={2} />
                </dd>
              </React.Fragment>
            ))}
          </dl>
        ) : null}

        {node.nodeId ? (
          <div className="flex items-center justify-between gap-2">
            <span
              className="font-mono text-[11px] text-muted-foreground"
              title={node.nodeId}
            >
              {node.nodeId}
            </span>
            {href ? (
              <a
                href={href}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium",
                  "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                Open node
                <ArrowUpRight
                  className="size-3 opacity-70"
                  aria-hidden="true"
                />
              </a>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Node not found.</p>
        )}
      </div>
    </div>
  );
}
