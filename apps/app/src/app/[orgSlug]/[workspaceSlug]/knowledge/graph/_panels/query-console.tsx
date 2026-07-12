"use client";

/**
 * query-console.tsx — Knowledge → Graph → Query tab.
 *
 * Two independent query surfaces, per the spec:
 *   1. graph.cypher ("run_cypher") — a Cypher-or-natural-language console.
 *      Toggle between raw Cypher and NL→Cypher translation (`nlQuery`); results
 *      render as a table. A "textarea with monospace styling" stands in for
 *      full syntax highlighting per the task's explicit allowance — adding a
 *      CodeMirror Cypher-language extension would be a new dependency for a
 *      cosmetic gain.
 *   2. ontology.query ("query_ontology") — a typed multi-hop traversal from a
 *      known start node (no Cypher required). This is the "console traversal"
 *      capability distinct from Cypher: it takes a start node id + relationship
 *      types/direction/depth instead of a query string.
 *
 * Both result surfaces render node cells via `NodeRef` + an "Open" link to the
 * node-detail route — the citation rule applies to query results exactly like
 * it does to Browse/Search rows.
 */

import * as React from "react";
import Link from "next/link";
import { Play, Route, AlertTriangle } from "lucide-react";
import type { GraphCypherOutput } from "@oxagen/oxagen/contracts/graph.cypher";
import type { OntologyQueryOutput } from "@oxagen/oxagen/contracts/ontology.query";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
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
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from "@/components/ui/table";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { workspace } from "@/lib/routes";
import { runCypherAction, ontologyQueryAction } from "../actions";
import { tryNodeRefFromCell, fromTraversedNode } from "./node-ref-adapters";

type CypherMode = "cypher" | "nl";
type RunState = "idle" | "loading" | "error" | "ready";
type CypherResult = Pick<GraphCypherOutput, "columns" | "rows" | "rowCount">;
type TraverseResult = Pick<OntologyQueryOutput, "startNode" | "nodes" | "edges" | "truncated">;
type Direction = "out" | "in" | "both";

export interface QueryConsoleProps {
  orgSlug: string;
  workspaceSlug: string;
}

export function QueryConsole({ orgSlug, workspaceSlug }: QueryConsoleProps) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto">
      <CypherConsole orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      <div className="border-t border-border/60 pt-4">
        <TraversalConsole orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CypherConsole — graph.cypher ("run_cypher")
// ---------------------------------------------------------------------------

function CypherConsole({ orgSlug, workspaceSlug }: QueryConsoleProps) {
  const [mode, setMode] = React.useState<CypherMode>("cypher");
  const [queryText, setQueryText] = React.useState("");
  const [state, setState] = React.useState<RunState>("idle");
  const [error, setError] = React.useState("");
  const [result, setResult] = React.useState<CypherResult | null>(null);

  const handleRun = React.useCallback(async () => {
    const trimmed = queryText.trim();
    if (!trimmed) return;
    setState("loading");
    const res = await runCypherAction({
      orgSlug,
      workspaceSlug,
      query: trimmed,
      nlQuery: mode === "nl",
    });
    if (!res.ok) {
      setError(res.error);
      setState("error");
      return;
    }
    setResult({ columns: res.columns, rows: res.rows, rowCount: res.rowCount });
    setState("ready");
  }, [orgSlug, workspaceSlug, queryText, mode]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Query console</h3>
        <SegmentedControl value={mode} onValueChange={(v) => setMode(v as CypherMode)} aria-label="Query mode">
          <SegmentedControlItem value="cypher">Cypher</SegmentedControlItem>
          <SegmentedControlItem value="nl">Natural language</SegmentedControlItem>
        </SegmentedControl>
      </div>

      <Textarea
        value={queryText}
        onChange={(e) => setQueryText(e.target.value)}
        placeholder={
          mode === "cypher"
            ? "MATCH (n:Feature) RETURN n.displayName AS name LIMIT 25"
            : "Show me the 10 most recently created features"
        }
        aria-label={mode === "cypher" ? "Cypher query" : "Natural-language query"}
        className="min-h-24 font-mono text-xs"
        spellCheck={false}
      />

      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          {mode === "cypher"
            ? "Read-only Cypher (writes are rejected)."
            : "Translated to read-only Cypher by the model before running."}
        </p>
        <Button size="sm" startIcon={<Play className="size-3.5" />} onClick={() => void handleRun()} loading={state === "loading"} disabled={queryText.trim().length === 0}>
          Run
        </Button>
      </div>

      {state === "error" ? (
        <ErrorState title="Query failed" description={error} retry={() => void handleRun()} />
      ) : null}

      {state === "ready" && result ? <CypherResultTable result={result} orgSlug={orgSlug} workspaceSlug={workspaceSlug} /> : null}
    </div>
  );
}

function CypherResultTable({
  result,
  orgSlug,
  workspaceSlug,
}: {
  result: CypherResult;
  orgSlug: string;
  workspaceSlug: string;
}) {
  if (result.rowCount === 0 || result.columns.length === 0) {
    return <p className="text-xs text-muted-foreground">Query ran successfully — no rows returned.</p>;
  }
  return (
    <div className="rounded-md border border-border/60">
      <Table density="compact">
        <TableHeader>
          <TableRow>
            {result.columns.map((col) => (
              <TableHead key={col}>{col}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.length === 0 ? (
            <TableEmpty colSpan={result.columns.length} />
          ) : (
            result.rows.map((row, i) => (
              <TableRow key={i}>
                {result.columns.map((col) => (
                  <TableCell key={col}>
                    <CellValue
                      value={(row as Record<string, unknown>)[col]}
                      orgSlug={orgSlug}
                      workspaceSlug={workspaceSlug}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function CellValue({
  value,
  orgSlug,
  workspaceSlug,
}: {
  value: unknown;
  orgSlug: string;
  workspaceSlug: string;
}) {
  const nodeRef = tryNodeRefFromCell(value);
  if (nodeRef) {
    return (
      <span className="inline-flex items-center gap-2">
        <NodeRef node={nodeRef} />
        {nodeRef.id ? (
          <Link
            href={workspace.knowledge.node({ orgSlug, workspaceSlug }, nodeRef.id)}
            className="text-xs font-medium text-primary hover:underline"
          >
            Open
          </Link>
        ) : null}
      </span>
    );
  }
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "object") {
    return <code className="break-all text-xs">{JSON.stringify(value)}</code>;
  }
  return <span className="text-xs">{String(value)}</span>;
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
  }, [orgSlug, workspaceSlug, startNodeId, edgeTypesInput, direction, maxDepth]);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Route className="size-3.5" aria-hidden="true" />
        Traverse from a node
      </h3>
      <p className="text-[11px] text-muted-foreground">
        Multi-hop traversal from a known node&apos;s publicId — paste one from a Browse or Search result.
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="col-span-2 flex flex-col gap-1">
          <Label htmlFor="traverse-start-node" className="text-[11px] text-muted-foreground">
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
          <Label htmlFor="traverse-direction" className="text-[11px] text-muted-foreground">
            Direction
          </Label>
          <Select value={direction} onValueChange={(v) => v && setDirection(v as Direction)}>
            <SelectTrigger id="traverse-direction" size="sm" aria-label="Direction">
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
          <Label htmlFor="traverse-depth" className="text-[11px] text-muted-foreground">
            Max depth
          </Label>
          <Input
            id="traverse-depth"
            type="number"
            min={1}
            max={5}
            value={maxDepth}
            onChange={(e) => setMaxDepth(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
            className="h-8 text-xs"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="traverse-edge-types" className="text-[11px] text-muted-foreground">
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
        <ErrorState title="Traversal failed" description={error} retry={() => void handleTraverse()} />
      ) : null}

      {state === "ready" && result ? (
        result.startNode === null ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            Start node not found in this workspace.
          </p>
        ) : (
          <TraversalResult result={result} orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
        )
      ) : null}
    </div>
  );
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
          {result.nodes.length} node{result.nodes.length === 1 ? "" : "s"} reached
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
                href={workspace.knowledge.node({ orgSlug, workspaceSlug }, node.nodeId)}
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
            {result.edges.length} edge{result.edges.length === 1 ? "" : "s"} traversed
          </p>
          <div className="flex flex-col gap-1">
            {result.edges.map((edge, i) => {
              const from = nodeById.get(edge.fromNodeId);
              const to = nodeById.get(edge.toNodeId);
              return (
                <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                  {from ? <NodeRef node={fromTraversedNode(from)} /> : <span>{edge.fromNodeId}</span>}
                  <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    -[{edge.edgeType}]→
                  </span>
                  {to ? <NodeRef node={fromTraversedNode(to)} /> : <span>{edge.toNodeId}</span>}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
