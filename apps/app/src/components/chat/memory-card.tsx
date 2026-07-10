"use client";
import * as React from "react";
import Link from "next/link";
import { Brain, Network } from "lucide-react";
import { TruncatedText } from "@/components/ui/truncated-text";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import { useTenantOptional } from "@/lib/tenant/tenant-context";
import type { MemoryRecallHit } from "./stream-event-types";

export interface MemoryCardProps {
  queryId: string;
  memories: MemoryRecallHit[];
  topN?: number;
}

// Epistemic class → text color. FACT is the most trustworthy (success);
// RULE is policy-enforced (warning, draws attention to enforcement); a plain
// OBSERVATION is muted since it is the lowest rung of the confidence ladder.
const CLASS_TEXT: Record<string, string> = {
  FACT: "text-success",
  RULE: "text-warning",
  OBSERVATION: "text-muted-foreground",
};

/**
 * MemoryCard — the "Grounded in" citation strip rendered under an assistant
 * answer. Each recalled memory that grounded the turn is cited by the
 * knowledge-graph node it is ABOUT (via the shared `NodeRef` chip: colour-coded
 * label, hover/click property popover, copyable id — never a bare UUID), with a
 * "View in graph" deep-link into the graph explorer focused on that node. The
 * memory's lesson is shown beneath as the supporting fact. This is the concrete
 * proof that the answer is grounded in specific, inspectable graph facts.
 */
export function MemoryCard({ memories, topN = 5 }: MemoryCardProps) {
  const tenant = useTenantOptional();
  const top = memories.slice(0, topN);
  if (top.length === 0) return null;
  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 space-y-2 p-3 text-sm animate-in"
      data-component="memory-card"
    >
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold">Recalled memories</span>
        <span className="ml-auto text-xs font-medium tabular-nums text-muted-foreground">
          {memories.length}
        </span>
      </div>
      <ul className="space-y-2">
        {top.map((m) => {
          const graphHref =
            m.node?.id && tenant
              ? `/${tenant.orgSlug}/${tenant.workspaceSlug}/knowledge/explore?focus=${encodeURIComponent(m.node.id)}`
              : null;
          return (
            <li key={m.id} className="rounded-xl bg-muted p-2 text-xs">
              {/* Graph citation: the fact this memory is grounded in, cited by
                  its human label via the shared NodeRef chip. */}
              {m.node ? (
                <div className="mb-1.5 flex items-center gap-2">
                  <NodeRef node={m.node} className="min-w-0" />
                  {graphHref ? (
                    <Link
                      href={graphHref}
                      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`View ${m.node.displayName} in the knowledge graph`}
                    >
                      <Network className="size-3" aria-hidden="true" />
                      View in graph
                    </Link>
                  ) : null}
                </div>
              ) : null}
              <div className="mb-1 flex items-center gap-2 flex-wrap">
                <span
                  className={`inline-flex items-center gap-1 text-xs font-medium uppercase ${CLASS_TEXT[m.memoryClass] ?? "text-foreground"}`}
                >
                  {m.memoryClass}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  confidence {Math.round(m.confidenceScore)}%
                </span>
                {m.enforcementScore != null && (
                  <span className="text-muted-foreground tabular-nums">
                    enforcement {m.enforcementScore}
                  </span>
                )}
                <span className="text-muted-foreground tabular-nums">
                  score {m.score.toFixed(2)}
                </span>
                {/* Fallback raw-id link only when the subject node could not be
                    resolved to a citable graph node (keeps a reference without a
                    graph deep-link). Resolved rows cite via NodeRef above. */}
                {!m.node && m.nodeRef ? (
                  <a
                    href={`#${m.nodeRef}`}
                    className="ml-auto truncate font-mono text-[10px] text-foreground hover:underline"
                  >
                    {m.nodeRef}
                  </a>
                ) : null}
              </div>
              <TruncatedText text={m.lesson} lines={3} className="leading-relaxed" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
