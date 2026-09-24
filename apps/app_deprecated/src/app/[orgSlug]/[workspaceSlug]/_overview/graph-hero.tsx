/**
 * graph-hero.tsx — Overview → Knowledge graph panel (the HUD centrepiece).
 *
 * The graph-grounding wedge shows the numbers that matter for grounding —
 * nodes, edges, connected repos + data sources (connection.list), and how
 * fast the graph is growing (graph.stats growth buckets: today vs yesterday,
 * this week vs last week, plus a 14-day daily bar).
 *
 * Two independent bounded reads run in parallel and fail open: a dead source
 * dims one cell, never the panel.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import type { GraphStatsOutput } from "@oxagen/oxagen/contracts/graph.stats";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import Link from "next/link";
import { Network, Boxes, GitGraph, Github, Plug } from "lucide-react";
import { Card } from "@/components/ui/card";
import { workspace } from "@/lib/routes";
import { EmptyState, ErrorState } from "../_shared/components";
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

  const ictx = invokeCtx(orgId, workspaceId, userId);

  const [statsRes, connRes] = await runInTenantScope(
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
        invoke("list_connections", {}, ictx, {
          surface: "agent",
        }) as Promise<ConnectionListOutput>,
      ]),
  );

  const stats = statsRes.status === "fulfilled" ? statsRes.value : null;
  const connections =
    connRes.status === "fulfilled" ? connRes.value.connections : [];

  const repoCount = connections.filter(
    (c) => c.connectorId === "github",
  ).length;
  const sourceCount = connections.length;
  const growth = stats?.growth ?? null;

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

  const coreFailed = statsRes.status !== "fulfilled";
  const isEmpty = (stats?.nodeCount ?? 0) === 0;

  const cells: StatCell[] = [
    { key: "nodes", label: "Nodes", value: stats?.nodeCount ?? 0, Icon: Boxes },
    {
      key: "edges",
      label: "Edges",
      value: stats?.edgeCount ?? 0,
      Icon: GitGraph,
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
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {cells.map(({ key, label, value, Icon }) => (
              <div
                key={key}
                className="flex flex-col gap-1 rounded-xl border border-border bg-card p-3"
                data-testid={`overview-graph-stat-${key}`}
              >
                {/* Wrap to two lines rather than truncate — these tiles are
                      narrow enough that a two-word label clips even on a
                      desktop viewport. */}
                <span className="flex items-start gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Icon
                    className="mt-px size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="line-clamp-2">{label}</span>
                </span>
                <span className="text-xl font-semibold tabular-nums leading-none text-foreground">
                  {value.toLocaleString()}
                </span>
              </div>
            ))}
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
      )}
    </Card>
  );
}
