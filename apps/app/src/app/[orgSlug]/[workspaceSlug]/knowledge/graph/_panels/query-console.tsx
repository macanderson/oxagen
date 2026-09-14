"use client";

/**
 * query-console.tsx — Knowledge → Graph → Query tab.
 *
 * Typed ontology.query ("query_ontology") traversal from a known start node.
 * Callers provide a node id plus relationship types/direction/depth; no raw
 * database query language is accepted.
 *
 * Both result surfaces render node cells via `NodeRef` + an "Open" link to the
 * node-detail route — the citation rule applies to query results exactly like
 * it does to Browse/Search rows.
 */

import * as React from "react";
import Link from "next/link";
import { Route, AlertTriangle } from "lucide-react";
import type { OntologyQueryOutput } from "@oxagen/oxagen/contracts/ontology.query";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { workspace } from "@/lib/routes";
import { ontologyQueryAction } from "../actions";
import { fromTraversedNode } from "./node-ref-adapters";

type RunState = "idle" | "loading" | "error" | "ready";
type TraverseResult = Pick<
  OntologyQueryOutput,
  "startNode" | "nodes" | "edges" | "truncated"
>;
type Direction = "out" | "in" | "both";

export interface QueryConsoleProps {
  orgSlug: string;
  workspaceSlug: string;
}

export function QueryConsole({ orgSlug, workspaceSlug }: QueryConsoleProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <TraversalConsole orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// TraversalConsole — ontology.query ("query_ontology")
// ---------------------------------------------------------------------------

function TraversalConsole({ orgSlug, workspaceSlug }: QueryConsoleProps) {
  const [startNodeId, setStartNodeId] = React.useState("");
  const [edgeTypesInput, setEdgeTypesInput] = React.useState("");
  const [direction, setDirection] = React.useState<Direction>("out");
  const [maxDepth, setMaxDepth] = React.useState(2);
  const [state, setState] = React.useState<RunState>("idle");
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState<TraverseResult | null>(null);

  const handleTraverse = React.useCallback(async () => {
    const trimmed = startNodeId.trim();
    if (!trimmed) return;
    setState("loading");
    const edgeTypes = edgeTypesInput
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const res = await ontologyQueryAction({
      orgSlug,
      workspaceSlug,
      startNodeId: trimmed,
      ...(edgeTypes.length > 0 ? { edgeTypes } : {}),
      direction,
      maxDepth,
    });
    if (!res.ok) {
      setError(res.error);
      setState("error");
      return;
    }
    setResult(res);
    setState("ready");
  }, [
    orgSlug,
    workspaceSlug,
    startNodeId,
    edgeTypesInput,
    direction,
    maxDepth,
  ]);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Route className="size-3.5" aria-hidden="true" />
        Traverse from a node
      </h3>
      <p className="text-[11px] text-muted-foreground">
        Multi-hop traversal from a known node&apos;s publicId — paste one from a
        Browse or Search result.
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="col-span-2 flex flex-col gap-1">
          <Label
            htmlFor="traverse-start-node"
            className="text-[11px] text-muted-foreground"
          >
            Start node ID
          </Label>
          <Input
            id="traverse-start-node"
            value={startNodeId}
            onChange={(e) => setStartNodeId(e.target.value)}
            placeholder="publicId…"
            className="h-8 text-xs"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="traverse-direction"
            className="text-[11px] text-muted-foreground"
          >
            Direction
          </Label>
          <Select
            value={direction}
            onValueChange={(v) => v && setDirection(v as Direction)}
          >
            <SelectTrigger
              id="traverse-direction"
              size="sm"
              aria-label="Direction"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="out">Outgoing</SelectItem>
              <SelectItem value="in">Incoming</SelectItem>
              <SelectItem value="both">Both</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="traverse-depth"
            className="text-[11px] text-muted-foreground"
          >
            Max depth
          </Label>
          <Input
            id="traverse-depth"
            type="number"
            min={1}
            max={5}
            value={maxDepth}
            onChange={(e) =>
              setMaxDepth(Math.min(5, Math.max(1, Number(e.target.value) || 1)))
            }
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label
          htmlFor="traverse-edge-types"
          className="text-[11px] text-muted-foreground"
        >
          Relationship types (comma-separated, optional)
        </Label>
        <Input
          id="traverse-edge-types"
          value={edgeTypesInput}
          onChange={(e) => setEdgeTypesInput(e.target.value)}
          placeholder="OWNS, DEPENDS_ON"
          className="h-8 text-xs"
        />
      </div>

      <div>
        <Button
          size="sm"
          variant="outline"
          startIcon={<Route className="size-3.5" />}
          onClick={() => void handleTraverse()}
          loading={state === "loading"}
          disabled={startNodeId.trim().length === 0}
        >
          Traverse
        </Button>
      </div>

      {state === "error" ? (
        <ErrorState
          title="Traversal failed"
          description={error}
          retry={() => void handleTraverse()}
        />
      ) : null}

      {state === "ready" && result ? (
        result.startNode === null ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            Start node not found in this workspace.
          </p>
        ) : (
          <TraversalResult
            result={result}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        )
      ) : null}
    </div>
  );
}

/**
 * Citation for an edge endpoint that `nodes` did not carry — the reachable-node
 * set is capped by `limit`, so a returned edge can point at a node outside it.
 * Cited as an unresolved endpoint rather than a bare publicId: the raw id is
 * never the primary on-screen identifier, it belongs in the popover's copyable
 * secondary (see node-ref.tsx's citation rule).
 */
function unreturnedEndpoint(nodeId: string): KnowledgeNodeRef {
  return {
    id: nodeId,
    label: "Unresolved",
    displayName: "",
    properties: {
      note: "Outside the returned node set — raise the traversal limit to resolve it.",
    },
  };
}

function TraversalResult({
  result,
  orgSlug,
  workspaceSlug,
}: {
  result: TraverseResult;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const nodeById = React.useMemo(
    () => new Map(result.nodes.map((n) => [n.nodeId, n])),
    [result.nodes],
  );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="mb-1 text-[11px] font-medium text-muted-foreground">
          {result.nodes.length} node{result.nodes.length === 1 ? "" : "s"}{" "}
          reached
          {result.truncated ? " (truncated)" : ""}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {result.nodes.map((node) => (
            <span key={node.nodeId} className="inline-flex items-center gap-1">
              <NodeRef node={fromTraversedNode(node)} />
              <Badge variant="muted" size="sm">
                depth {node.depth}
              </Badge>
              <Link
                href={workspace.knowledge.node(
                  { orgSlug, workspaceSlug },
                  node.nodeId,
                )}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                Open
              </Link>
            </span>
          ))}
        </div>
      </div>

      {result.edges.length > 0 ? (
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">
            {result.edges.length} edge{result.edges.length === 1 ? "" : "s"}{" "}
            traversed
          </p>
          <div className="flex flex-col gap-1">
            {result.edges.map((edge, i) => {
              const from = nodeById.get(edge.fromNodeId);
              const to = nodeById.get(edge.toNodeId);
              return (
                <div
                  key={i}
                  className="flex flex-wrap items-center gap-1.5 text-xs"
                >
                  <NodeRef
                    node={
                      from
                        ? fromTraversedNode(from)
                        : unreturnedEndpoint(edge.fromNodeId)
                    }
                  />
                  <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    -[{edge.edgeType}]→
                  </span>
                  <NodeRef
                    node={
                      to
                        ? fromTraversedNode(to)
                        : unreturnedEndpoint(edge.toNodeId)
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
