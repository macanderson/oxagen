"use client";

/**
 * agents-grid.tsx — card-grid presentation of the workspace's agent
 * definitions, with client-side search / sort / pagination / CSV export via
 * the shared list toolkit. Each agent renders as a card headed by its
 * EntityAvatar and cited by its LLM-inferred summary (fallback: the
 * user-provided description), never as a bare table row.
 *
 * The card keeps the `agent-row-<slug>` testid and puts the detail link
 * first — e2e specs navigate via `getByTestId(...).getByRole("link").first()`.
 */

import * as React from "react";
import Link from "next/link";
import { Rocket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { EntityAvatar } from "@/components/avatar/entity-avatar";
import { CardGrid } from "@/components/lists/card-grid";
import { ListToolbar } from "@/components/lists/list-toolbar";
import { ListPagination } from "@/components/lists/list-pagination";
import {
  useListControls,
  type ListSortOption,
} from "@/lib/lists/use-list-controls";
import { toCsv, downloadCsv, type CsvColumn } from "@/lib/lists/csv";
import type { AgentListRow } from "@/lib/workbench/agents";

/** A list row enriched server-side with its route targets. */
export type AgentGridRow = AgentListRow & {
  /** Agent Builder detail page href. */
  detailHref: string;
  /** Ask-surface launch href — null when the agent is not deployed. */
  launchHref: string | null;
};

const SORT_OPTIONS: ListSortOption<AgentGridRow>[] = [
  {
    id: "name",
    label: "Name A–Z",
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    id: "version",
    label: "Most iterated",
    compare: (a, b) => (b.latestVersion ?? 0) - (a.latestVersion ?? 0),
  },
  {
    id: "status",
    label: "Status",
    compare: (a, b) => a.status.localeCompare(b.status),
  },
];

const CSV_COLUMNS: CsvColumn[] = [
  { key: "name", header: "Name" },
  { key: "slug", header: "Slug" },
  { key: "agentKey", header: "Agent key" },
  { key: "status", header: "Status" },
  { key: "deploymentStatus", header: "Deployment" },
  { key: "latestVersion", header: "Version" },
  { key: "summary", header: "Summary" },
  { key: "description", header: "Description" },
];

function statusVariant(
  status: AgentListRow["status"],
): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "archived") return "outline";
  return "secondary";
}

/** The blurb cited on the card: inferred summary → description → placeholder. */
function blurbOf(agent: AgentGridRow): string {
  return agent.summary ?? agent.description ?? "No description yet.";
}

export function AgentsGrid({ agents }: { agents: AgentGridRow[] }) {
  const controls = useListControls(agents, {
    searchKeys: [
      "name",
      "slug",
      (row) => blurbOf(row),
      (row) => row.agentKey ?? "",
    ],
    sortOptions: SORT_OPTIONS,
    pageSize: 12,
  });

  const handleExport = React.useCallback(() => {
    downloadCsv(
      "agents.csv",
      toCsv(
        CSV_COLUMNS,
        controls.allFilteredRows as unknown as Record<string, unknown>[],
      ),
    );
  }, [controls.allFilteredRows]);

  return (
    <div className="flex flex-col gap-4" data-testid="agents-grid">
      <ListToolbar
        query={controls.query}
        onQueryChange={controls.setQuery}
        searchPlaceholder="Search agents…"
        sortOptions={SORT_OPTIONS}
        sortId={controls.sortId}
        onSortChange={controls.setSortId}
        onExport={handleExport}
      />

      {controls.filteredTotal === 0 ? (
        <p
          className="rounded-md border bg-card py-12 text-center text-sm text-muted-foreground"
          data-testid="agents-no-matches"
        >
          No agents match “{controls.query}”.
        </p>
      ) : (
        <CardGrid>
          {controls.pageRows.map((agent) => (
            <article
              key={agent.agentId}
              className="flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-border/80"
              data-testid={`agent-row-${agent.slug}`}
            >
              {/* Header: avatar + name (detail link — MUST stay the card's
                  first link, e2e clicks .getByRole("link").first()) + slug. */}
              <div className="flex items-start gap-3">
                <EntityAvatar
                  value={agent.avatarUrl}
                  name={agent.name}
                  shape="square"
                  size="lg"
                />
                <div className="min-w-0 flex-1">
                  <Link
                    href={agent.detailHref}
                    className="font-medium text-foreground hover:underline"
                    data-testid={`agent-link-${agent.slug}`}
                  >
                    {agent.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {agent.slug}
                    </span>
                    {agent.managed ? (
                      <Badge variant="outline" className="text-[10px]">
                        Managed
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* LLM-inferred summary (≤256 chars server-side); clamped so
                  cards stay even in the grid. */}
              <p className="line-clamp-3 min-h-10 text-sm text-muted-foreground">
                {blurbOf(agent)}
              </p>

              {/* Footer: state badges + version + primary action. The
                  deployment badge is labeled by meaning ("Deployed"), not the
                  raw enum — both fields read "active" on a live agent and the
                  card would otherwise show two identical "Active" chips. */}
              <div className="mt-auto flex flex-wrap items-center gap-2">
                <Badge
                  variant={statusVariant(agent.status)}
                  className="text-xs capitalize"
                >
                  {agent.status}
                </Badge>
                <Badge
                  variant={
                    agent.deploymentStatus === "active"
                      ? "default"
                      : "secondary"
                  }
                  className="text-xs"
                >
                  {agent.deploymentStatus === "active"
                    ? "Deployed"
                    : "Not deployed"}
                </Badge>
                {agent.latestVersion !== null ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    v{agent.latestVersion}
                  </span>
                ) : null}
                <span className="flex-1" />
                {agent.launchHref ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    endIcon={
                      <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                    data-testid={`agent-launch-${agent.slug}`}
                    render={<Link href={agent.launchHref} />}
                  >
                    Launch
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    data-testid={`agent-edit-${agent.slug}`}
                    render={<Link href={agent.detailHref} />}
                  >
                    {agent.managed ? "View" : "Edit"}
                  </Button>
                )}
              </div>

              {agent.agentKey ? (
                <CopyableId value={agent.agentKey} label="key" max={40} />
              ) : null}
            </article>
          ))}
        </CardGrid>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {controls.filteredTotal === controls.total
            ? `${controls.total} agent${controls.total === 1 ? "" : "s"}`
            : `${controls.filteredTotal} of ${controls.total} agents`}
        </p>
        <ListPagination
          page={controls.page}
          pageCount={controls.pageCount}
          onPageChange={controls.setPage}
        />
      </div>
    </div>
  );
}
