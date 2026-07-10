"use client";
import * as React from "react";
import Link from "next/link";
import { Brain, ChevronDown, Network } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Badge } from "@/components/ui/badge";
import { TruncatedText } from "@/components/ui/truncated-text";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import { useTenantOptional } from "@/lib/tenant/tenant-context";
import { transition } from "@oxagen/ui/lib/motion";
import { cn } from "@/lib/utils";
import type { KnowledgeNodeRef, MemoryRecallHit } from "./stream-event-types";

export interface MemoryCardProps {
  queryId: string;
  memories: MemoryRecallHit[];
  topN?: number;
  /**
   * "recall" (default) summarizes the grounding of an answer ("Grounded in …");
   * "write" is the memory-write confirmation reuse of this card ("Remembered …").
   */
  variant?: "recall" | "write";
}

// Epistemic class → badge variant. FACT is the most trustworthy (success);
// RULE is policy-enforced (warning, draws attention to enforcement); a plain
// OBSERVATION is muted since it is the lowest rung of the confidence ladder.
const CLASS_VARIANT: Record<
  string,
  "success" | "warning" | "muted" | "default"
> = {
  FACT: "success",
  RULE: "warning",
  OBSERVATION: "muted",
};

/**
 * Unique grounding nodes across the recalled memories. Deduped by `node.id`;
 * un-materialised candidates (`id: null`) cannot be identified, so each one is
 * kept as its own citation rather than collapsed together.
 */
function uniqueGroundingNodes(memories: MemoryRecallHit[]): KnowledgeNodeRef[] {
  const seen = new Set<string>();
  const nodes: KnowledgeNodeRef[] = [];
  for (const memory of memories) {
    const node = memory.node;
    if (!node) continue;
    if (node.id) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
    }
    nodes.push(node);
  }
  return nodes;
}

/** Naive domain-label pluralizer — append "s" unless the label already ends in one. */
function pluralizeLabel(label: string, count: number): string {
  if (count === 1) return label;
  return label.endsWith("s") ? label : `${label}s`;
}

/** Natural-language list join: "A" · "A and B" · "A, B, and C". */
function joinClauses(parts: string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  const last = parts.at(-1) ?? "";
  return `${parts.slice(0, -1).join(", ")}, and ${last}`;
}

/**
 * The one-sentence collapsed summary: counts of unique grounding nodes grouped
 * by domain label ("Grounded in 2 Features, 1 Repository, and 1 Person."),
 * with an appended clause for memories that resolved no graph node, and a
 * plain recalled-memory count when nothing resolved at all.
 */
function summarySentence(
  memories: MemoryRecallHit[],
  nodes: KnowledgeNodeRef[],
  variant: "recall" | "write",
): string {
  const verb = variant === "write" ? "Remembered" : "Grounded in";
  if (nodes.length === 0) {
    const noun =
      variant === "write"
        ? memories.length === 1
          ? "memory"
          : "memories"
        : memories.length === 1
          ? "recalled memory"
          : "recalled memories";
    return `${verb} ${memories.length} ${noun}.`;
  }
  // Group by domain label, highest count first (stable sort keeps first-seen
  // order on ties, so the sentence is deterministic for a given stream).
  const countsByLabel = new Map<string, number>();
  for (const node of nodes) {
    countsByLabel.set(node.label, (countsByLabel.get(node.label) ?? 0) + 1);
  }
  const clauses = [...countsByLabel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} ${pluralizeLabel(label, count)}`);
  const uncited = memories.filter((m) => !m.node).length;
  const uncitedClause =
    uncited > 0
      ? `, plus ${uncited} uncited ${uncited === 1 ? "memory" : "memories"}`
      : "";
  return `${verb} ${joinClauses(clauses)}${uncitedClause}.`;
}

/**
 * MemoryCard — the "Grounded in" citation card rendered under an assistant
 * answer. Collapsed, it is a single sentence summarizing the node TYPES the
 * answer was grounded in (unique grounding nodes grouped by domain label).
 * Expanded, each unique grounding node is cited via the shared `NodeRef` chip
 * (colour-coded label, hover/click property popover, copyable id — never a
 * bare UUID) with a "View in graph" deep-link into the graph explorer, above
 * the per-memory evidence (class, confidence, enforcement, score, lesson).
 * This is the concrete proof that the answer is grounded in specific,
 * inspectable graph facts.
 */
export function MemoryCard({
  memories,
  topN = 5,
  variant = "recall",
}: MemoryCardProps) {
  const tenant = useTenantOptional();
  const reducedMotion = useReducedMotion();
  const [expanded, setExpanded] = React.useState(false);
  const panelId = React.useId();
  if (memories.length === 0) return null;
  const top = memories.slice(0, topN);
  const nodes = uniqueGroundingNodes(memories);
  const sentence = summarySentence(memories, nodes, variant);
  const graphHrefFor = (node: KnowledgeNodeRef): string | null =>
    node.id && tenant
      ? `/${tenant.orgSlug}/${tenant.workspaceSlug}/knowledge/explore?focus=${encodeURIComponent(node.id)}`
      : null;
  return (
    <div
      className="my-1.5 rounded-xl border border-border/60 bg-card/60 p-3 text-sm text-card-foreground animate-in"
      data-component="memory-card"
    >
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium text-foreground/90">
          {sentence}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={expanded ? "Hide citations" : "Show citations"}
          className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            className={cn(
              "size-4 transition-transform",
              expanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      {/* The panel element always exists so aria-controls stays valid; its
          content only mounts (and height-animates) when expanded. */}
      <div id={panelId}>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              key="memory-body"
              initial={
                reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }
              }
              animate={
                reducedMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }
              }
              exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={transition.base}
              style={{ overflow: "hidden" }}
            >
              <div className="mt-2 space-y-2">
                {nodes.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                    {nodes.map((node, i) => {
                      const graphHref = graphHrefFor(node);
                      return (
                        <span
                          key={node.id ?? `candidate-${i}`}
                          className="inline-flex min-w-0 items-center gap-0.5"
                        >
                          <NodeRef node={node} className="min-w-0" />
                          {graphHref ? (
                            <Link
                              href={graphHref}
                              className="inline-flex shrink-0 items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`View ${node.displayName} in the knowledge graph`}
                            >
                              <Network className="size-3" aria-hidden="true" />
                            </Link>
                          ) : null}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                <ul className="space-y-2">
                  {top.map((m) => (
                    <li
                      key={m.id}
                      className="rounded-xl bg-muted/70 p-2 text-xs"
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge
                          variant={CLASS_VARIANT[m.memoryClass] ?? "default"}
                          // Badge spreads extra props onto its span — expose the
                          // variant + a stable testid for assertions (the shared
                          // component itself emits no data attributes).
                          data-testid="badge"
                          data-variant={CLASS_VARIANT[m.memoryClass] ?? "default"}
                          className="uppercase"
                        >
                          {m.memoryClass}
                        </Badge>
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
                        {/* Fallback raw-id reference only when the subject node
                            could not be resolved to a citable graph node.
                            Resolved memories are cited via the NodeRef chips. */}
                        {!m.node && m.nodeRef ? (
                          <a
                            href={`#${m.nodeRef}`}
                            className="ml-auto truncate font-mono text-[10px] text-foreground hover:underline"
                          >
                            {m.nodeRef}
                          </a>
                        ) : null}
                      </div>
                      <TruncatedText
                        text={m.lesson}
                        lines={3}
                        className="leading-relaxed"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
