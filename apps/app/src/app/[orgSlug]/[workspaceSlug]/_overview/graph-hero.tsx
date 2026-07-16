/**
 * graph-hero.tsx — Overview → Knowledge graph panel (the HUD centrepiece).
 *
 * The graph-grounding wedge, made visual: a tiny live subgraph preview
 * (export_graph → reagraph) beside the numbers that matter for grounding —
 * nodes, edges, inferred edges *pending approval* (semantic.edge.suggest.total),
 * connected repos + data sources (connection.list, split by connector), and how
 * fast the graph is growing (graph.stats growth buckets: today vs yesterday,
 * this week vs last week, plus a 14-day daily bar).
 *
 * Four independent reads run in parallel and fail open: a dead source dims one
 * cell, never the panel. export_graph is invoked with surface "api" (it has no
 * agent surface); the rest use surface "agent" like every other tile.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { GraphStatsOutput } from "@oxagen/oxagen/contracts/graph.stats";
import type { GraphExportOutput } from "@oxagen/oxagen/contracts/graph.export";
import type { SemanticEdgeSuggestOutput } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import Link from "next/link";
import { Network, Boxes, GitGraph, Sparkles, Github, Plug } from "lucide-react";
import { Card } from "@/components/ui/card";
import { workspace } from "@/lib/routes";
import { EmptyState, ErrorState } from "../_shared/components";
import { GraphMiniViz } from "./graph-mini-viz";
import type { MiniEdge, MiniNode } from "./graph-mini-canvas";
import { DeltaChip } from "./hud/delta-chip";
import { MiniBars } from "./hud/mini-bars";

interface Props {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * Node-creation growth block added to graph.stats by the includeGrowth option.
 * Read structurally so the panel compiles and degrades gracefully whether or
 * not the extended field is present in a given deployment.
 */
interface NodeGrowth {
  nodesToday: number;
  nodesYesterday: number;
  nodesThisWeek: number;
  nodesLastWeek: number;
  daily: Array<{ day: string; count: number }>;
}

const MINI_VIZ_LIMIT = 30;

function invokeCtx(orgId: string, workspaceId: string, userId: string) {
  return {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

/** reagraph node size grows with connectivity, capped so a hub can't swamp. */
function nodeSize(degree: number): number {
  return Math.min(5 + degree * 1.3, 18);
}

function toMiniGraph(exported: GraphExportOutput | null): {
  nodes: MiniNode[];
  edges: MiniEdge[];
} {
  if (!exported) return { nodes: [], edges: [] };
  const degree = new Map<string, number>();
  for (const e of exported.edges) {
    degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
    degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
  }
  const ids = new Set(exported.nodes.map((n) => n.id));
  const nodes: MiniNode[] = exported.nodes.map((n) => ({
    id: n.id,
    label: n.displayName,
    group: n.labels?.[0] ?? "Node",
    size: nodeSize(degree.get(n.id) ?? 0),
  }));
  // Only keep edges whose endpoints are both in the sampled node set.
  const edges: MiniEdge[] = exported.edges
    .filter((e) => ids.has(e.sourceId) && ids.has(e.targetId))
    .map((e) => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      inferred: e.inferred,
    }));
  return { nodes, edges };
}

interface StatCell {
  key: string;
  label: string;
  value: number;
  Icon: typeof Boxes;
}

export async function GraphHero({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: Props) {
  const ctx = { orgSlug, workspaceSlug };
  const exploreHref = workspace.knowledge.graph(ctx);
  const sourcesHref = workspace.knowledge.sources(ctx);
  const inferenceHref = workspace.knowledge.inference(ctx);

  const ictx = invokeCtx(orgId, workspaceId, userId);

  const [statsRes, exportRes, pendingRes, connRes] = await runInTenantScope(
    { orgId, workspaceId },
    () =>
      Promise.allSettled([
        invoke(
          "get_graph_stats",
          { includeByType: false, includeGrowth: true },
          ictx,
          {
            surface: "agent",
          },
        ) as Promise<GraphStatsOutput & { growth?: NodeGrowth }>,
        invoke(
          "export_graph",
          { includeEdges: true, limit: MINI_VIZ_LIMIT },
          ictx,
          {
            surface: "api",
          },
        ) as Promise<GraphExportOutput>,
        invoke("suggest_semantic_edges", { limit: 1 }, ictx, {
          surface: "agent",
        }) as Promise<SemanticEdgeSuggestOutput>,
        invoke("list_connections", {}, ictx, {
          surface: "agent",
        }) as Promise<ConnectionListOutput>,
      ]),
  );

  const stats = statsRes.status === "fulfilled" ? statsRes.value : null;
  const exported = exportRes.status === "fulfilled" ? exportRes.value : null;
  const pendingTotal =
    pendingRes.status === "fulfilled" ? pendingRes.value.total : 0;
  const connections =
    connRes.status === "fulfilled" ? connRes.value.connections : [];

  const repoCount = connections.filter(
    (c) => c.connectorId === "github",
  ).length;
  const sourceCount = connections.length;
  const growth = stats?.growth ?? null;
  const { nodes, edges } = toMiniGraph(exported);

  const header = (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Network className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-medium text-foreground">Knowledge graph</h2>
      </div>
      <Link
        href={exploreHref}
        className="text-sm font-medium text-primary hover:underline"
      >
        Explore graph →
      </Link>
    </div>
  );

  // The stats + export reads back the node counts and the mini-viz — the core
  // of the panel. If BOTH reject (e.g. a graph-store outage) we can't tell an
  // empty graph from an unreachable one, so surface an error rather than
  // falsely claiming "No graph data yet". Per-cell fail-open is preserved for
  // partial failures (e.g. only connection.list or suggest_semantic_edges).
  const coreFailed =
    statsRes.status !== "fulfilled" && exportRes.status !== "fulfilled";
  const isEmpty = (stats?.nodeCount ?? 0) === 0 && nodes.length === 0;

  const cells: StatCell[] = [
    { key: "nodes", label: "Nodes", value: stats?.nodeCount ?? 0, Icon: Boxes },
    {
      key: "edges",
      label: "Edges",
      value: stats?.edgeCount ?? 0,
      Icon: GitGraph,
    },
    {
      key: "pending",
      label: "Inferred · pending approval",
      value: pendingTotal,
      Icon: Sparkles,
    },
    { key: "repos", label: "Repos", value: repoCount, Icon: Github },
    { key: "sources", label: "Data sources", value: sourceCount, Icon: Plug },
  ];

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="overview-graph-hero">
      {header}

      {coreFailed ? (
        <ErrorState
          title="Knowledge graph unavailable"
          description="Could not load your knowledge graph. This is usually temporary — try again shortly."
        />
      ) : isEmpty ? (
        <EmptyState
          icon={Network}
          title="No graph data yet"
          description="Connect a source and run a sync to start grounding answers in a cited, time-aware graph."
          action={
            <Link
              href={sourcesHref}
              className="text-sm font-medium text-primary hover:underline"
            >
              Connect a source →
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          {/* Left: live subgraph preview */}
          <div className="flex flex-col gap-1.5">
            {nodes.length > 0 ? (
              <GraphMiniViz nodes={nodes} edges={edges} />
            ) : (
              <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-border text-xs text-muted-foreground sm:h-64">
                Preview unavailable
              </div>
            )}
            <p className="px-1 text-[11px] text-muted-foreground">
              Live sample · up to {MINI_VIZ_LIMIT} nodes ·{" "}
              <span className="text-purple-500">dashed</span> edges are inferred
            </p>
          </div>

          {/* Right: stats + growth */}
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {cells.map(({ key, label, value, Icon }) => (
                <div
                  key={key}
                  className="flex flex-col gap-1 rounded-xl border border-border bg-card p-3"
                  data-testid={`overview-graph-stat-${key}`}
                >
                  {/* Wrap to two lines rather than truncate — these tiles are
                      narrow and "Inferred · pending approval" was rendering as
                      "INFERRED · PENDING A…" even on a 1440px viewport. */}
                  <span className="flex items-start gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    <span className="line-clamp-2">{label}</span>
                  </span>
                  <span className="text-xl font-semibold tabular-nums leading-none text-foreground">
                    {value.toLocaleString()}
                  </span>
                </div>
              ))}
              {pendingTotal > 0 ? (
                <Link
                  href={inferenceHref}
                  className="flex items-center justify-center rounded-xl border border-dashed border-primary/40 p-3 text-center text-xs font-medium text-primary hover:bg-primary/5"
                >
                  Review {pendingTotal.toLocaleString()} pending →
                </Link>
              ) : null}
            </div>

            {/* Node-creation growth */}
            <div className="rounded-xl border border-border bg-card p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  New nodes
                </span>
                {growth ? (
                  <MiniBars
                    values={growth.daily.map((d) => d.count)}
                    highlightLast
                    aria-label="New nodes over the last 14 days"
                  />
                ) : null}
              </div>
              {growth ? (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-lg font-semibold tabular-nums leading-none text-foreground">
                      {growth.nodesToday.toLocaleString()}
                    </span>
                    <DeltaChip
                      current={growth.nodesToday}
                      previous={growth.nodesYesterday}
                      goodDirection="up"
                      label="vs yesterday"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-lg font-semibold tabular-nums leading-none text-foreground">
                      {growth.nodesThisWeek.toLocaleString()}
                    </span>
                    <DeltaChip
                      current={growth.nodesThisWeek}
                      previous={growth.nodesLastWeek}
                      goodDirection="up"
                      label="this wk vs last"
                    />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Growth trend unavailable.
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
