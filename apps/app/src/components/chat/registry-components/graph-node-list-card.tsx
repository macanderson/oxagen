"use client";
import * as React from "react";
import { resolveRecordHref } from "@oxagen/oxagen/capability-meta";
import { Network, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { TruncatedText } from "@/components/ui/truncated-text";

/**
 * graph-node-list-card — renders the result of graph.node.list / graph.node.search
 * as a list of nodes, each deep-linked to its detail page. Handles both output
 * shapes: list uses `nodes[].id`, search uses `nodes[].nodeId` + `score`.
 *
 * componentId: "graph-node-list-card"
 */

interface GraphNodeListCardProps {
  capability?: string;
  output?: unknown;
  orgSlug?: string;
  workspaceSlug?: string;
}

interface Row {
  id: string;
  displayName: string;
  labels: string[];
  description?: string;
  score?: number;
}

const MAX_ROWS = 25;

/**
 * The best human label for a node row — never empty, and never the raw id.
 * Mirrors `nodeCitationLabel` in components/knowledge/graph/node-ref.tsx: a
 * `displayName` equal to the id is the server's last-resort coalesce fallback,
 * not a human name, so it is skipped in favour of the domain label.
 */
export function humanLabel(
  displayName: unknown,
  labels: string[],
  id: string,
): string {
  if (typeof displayName === "string") {
    const trimmed = displayName.trim();
    if (trimmed && trimmed !== id) return trimmed;
  }
  return labels[0] ?? "Unknown node";
}

function readRows(output: unknown): { rows: Row[]; total: number } {
  if (typeof output !== "object" || output === null)
    return { rows: [], total: 0 };
  const o = output as Record<string, unknown>;
  const nodes = Array.isArray(o.nodes) ? o.nodes : [];
  const rows: Row[] = [];
  for (const raw of nodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const n = raw as Record<string, unknown>;
    const id =
      typeof n.nodeId === "string"
        ? n.nodeId
        : typeof n.id === "string"
          ? n.id
          : "";
    if (!id) continue;
    const labels =
      typeof n.label === "string"
        ? [n.label]
        : Array.isArray(n.labels)
          ? n.labels.filter((l): l is string => typeof l === "string")
          : [];
    rows.push({
      id,
      // A node is never cited by its raw id. `displayName` is the server's
      // coalesce of displayName→name→publicId, so it can arrive absent or
      // equal to the id itself; in either case fall back to the domain label
      // and only then to a generic placeholder. The id stays available in the
      // row's deep link, never as the on-screen identifier.
      displayName: humanLabel(n.displayName, labels, id),
      labels,
      description:
        typeof n.description === "string" ? n.description : undefined,
      score: typeof n.score === "number" ? n.score : undefined,
    });
  }
  const total = typeof o.total === "number" ? o.total : rows.length;
  return { rows, total };
}

export default function GraphNodeListCard(
  props: GraphNodeListCardProps,
): React.ReactElement {
  const { rows, total } = readRows(props.output);
  const slugs = { orgSlug: props.orgSlug, workspaceSlug: props.workspaceSlug };
  const shown = rows.slice(0, MAX_ROWS);

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="graph-node-list-card"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Network className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">
          {total} node{total === 1 ? "" : "s"}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No matching nodes.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {shown.map((row) => {
            const href = resolveRecordHref("graph.node", row.id, slugs);
            // The description's TruncatedText reveal is an interactive trigger
            // (a button in a popover), so it must NOT be nested inside the row's
            // anchor — nested interactive elements are invalid HTML. Only the
            // title/badges/score row is the click target; the description sits
            // below it, still inside the <li> but outside the <a>.
            const inner = (
              <div className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium"
                    title={row.displayName}
                  >
                    {row.displayName}
                  </p>
                </div>
                {row.labels.slice(0, 2).map((l) => (
                  <span
                    key={l}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {l}
                  </span>
                ))}
                {row.score !== undefined ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {row.score.toFixed(2)}
                  </span>
                ) : null}
                {href ? (
                  <ArrowUpRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            );
            return (
              <li key={row.id}>
                {href ? (
                  <a
                    href={href}
                    className={cn(
                      "block hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
                  >
                    {inner}
                  </a>
                ) : (
                  inner
                )}
                {row.description ? (
                  <p className="px-4 pb-2 text-xs text-muted-foreground">
                    <TruncatedText text={row.description} lines={1} />
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > MAX_ROWS ? (
        <p className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
          Showing {MAX_ROWS} of {rows.length}.
        </p>
      ) : null}
    </div>
  );
}
