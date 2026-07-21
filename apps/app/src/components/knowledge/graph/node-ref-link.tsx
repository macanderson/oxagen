"use client";

/**
 * node-ref-link.tsx — a clickable node citation.
 *
 * `NodeRef` (./node-ref.tsx) is the canonical inspect-on-hover node chip — its
 * trigger is a `<button>`, so it cannot be nested inside a `<Link>` (a button
 * nested in an anchor is invalid HTML and leaves the click target ambiguous).
 * This composes the UNMODIFIED `NodeRef` chip with a small, separate "open
 * detail" icon-button, mirroring the exact pattern the Graph canvas/browse
 * page already uses for the same split (see
 * knowledge/graph/_panels/graph-result-row.tsx: NodeRef stays the inspect
 * surface; a `Button render={<Link/>}` — coss-ui's `render`-not-`asChild`
 * idiom — is the separate navigation target). New file, not a fork —
 * `NodeRef`'s internals are untouched; this only reuses it.
 *
 * Used by the Knowledge → Graph node-detail Neighbors section (spec:
 * docs/web-app-2.0/workspace/knowledge/graph/node/spec.md) so a neighbor chip
 * both inspects in place and opens its own detail page.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NodeRef, nodeCitationLabel } from "./node-ref";

export interface NodeRefLinkProps {
  node: KnowledgeNodeRef;
  /**
   * Node-detail URL. Omit (or pass a falsy value) to render the inspect chip
   * without a navigation affordance — e.g. an unmaterialised candidate
   * (`node.id === null`) that has nowhere to link to yet.
   */
  href?: string | null;
  className?: string;
}

/** A `NodeRef` inspect chip plus a distinct, non-nested "open detail" control. */
export function NodeRefLink({ node, href, className }: NodeRefLinkProps) {
  const label = nodeCitationLabel(node);

  return (
    <span
      className={cn("inline-flex max-w-full items-center gap-0.5", className)}
    >
      <NodeRef node={node} />
      {href ? (
        <Button
          size="icon-sm"
          variant="ghost"
          render={<Link href={href} />}
          aria-label={`Open ${label} detail`}
        >
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Button>
      ) : null}
    </span>
  );
}
