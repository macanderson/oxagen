"use client";

/**
 * agents-grid.tsx — card-grid presentation of the workspace's agent
 * definitions, with client-side search / status filter / sort / pagination /
 * CSV export via the shared list toolkit. Each agent renders as a card headed
 * by its EntityAvatar and cited by its LLM-inferred summary (fallback: the
 * user-provided description), never as a bare table row.
 *
 * The card keeps the `agent-row-<slug>` testid and puts the detail link
 * first — e2e specs navigate via `getByTestId(...).getByRole("link").first()`.
 * Deployment renders as a StatusDot labeled "Deployed"/"Not deployed" (never a
 * second "Active" badge — both enums read "active" on a live agent).
 */

import * as React from "react";
import Link from "next/link";
import { Bot, Rocket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { StatusDot } from "@/components/ui/status-dot";
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

/** Segmented status filter — the slices a fleet operator actually scans for. */
export type AgentStatusFilter = "all" | "deployed" | "draft" | "archived";

/** Pure filter predicate, exported for unit testing without mounting the grid. */
export function matchesStatusFilter(
  agent: Pick<AgentGridRow, "status" | "deploymentStatus">,
  filter: AgentStatusFilter,
): boolean {
  switch (filter) {
    case "deployed":
      return agent.deploymentStatus === "active";
    case "draft":
      return agent.status === "draft";
    case "archived":
      return agent.status === "archived";
    default:
      return true;
  }
}

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
  const [statusFilter, setStatusFilter] =
    React.useState<AgentStatusFilter>("all");

  const visible = React.useMemo(
    () => agents.filter((a) => matchesStatusFilter(a, statusFilter)),
    [agents, statusFilter],
  );

  const counts = React.useMemo(
    () => ({
      all: agents.length,
      deployed: agents.filter((a) => matchesStatusFilter(a, "deployed")).length,
      draft: agents.filter((a) => matchesStatusFilter(a, "draft")).length,
      archived: agents.filter((a) => matchesStatusFilter(a, "archived")).length,
    }),
    [agents],
  );

  const controls = useListControls(visible, {
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

      {/* Status slices — horizontal scroll keeps all four reachable at 390px. */}
      <div className="-mx-1 overflow-x-auto px-1">
        <SegmentedControl
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as AgentStatusFilter)}
          aria-label="Filter agents by status"
        >
          <SegmentedControlItem value="all" data-testid="agents-filter-all">
            All ({counts.all})
          </SegmentedControlItem>
          <SegmentedControlItem
            value="deployed"
            data-testid="agents-filter-deployed"
          >
            Deployed ({counts.deployed})
          </SegmentedControlItem>
          <SegmentedControlItem value="draft" data-testid="agents-filter-draft">
            Drafts ({counts.draft})
          </SegmentedControlItem>
          <SegmentedControlItem
            value="archived"
            data-testid="agents-filter-archived"
          >
            Archived ({counts.archived})
          </SegmentedControlItem>
        </SegmentedControl>
      </div>

      {controls.filteredTotal === 0 ? (
        <EmptyState
          variant="muted"
          icon={<Bot />}
          title="No matching agents"
          description={
            controls.query.trim()
              ? `No agents match “${controls.query}”.`
              : "No agents in this slice yet."
          }
          data-testid="agents-no-matches"
        />
      ) : (
        <CardGrid>
          {controls.pageRows.map((agent) => {
            const deployed = agent.deploymentStatus === "active";
            return (
              <article
                key={agent.agentId}
                className="group flex flex-col gap-2.5 rounded-xl border bg-card p-4 transition-all hover:border-border hover:shadow-sm"
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
                      className="font-medium leading-tight text-foreground hover:underline"
                      data-testid={`agent-link-${agent.slug}`}
                    >
                      {agent.name}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate font-mono">{agent.slug}</span>
                      {agent.latestVersion !== null ? (
                        <span className="shrink-0 tabular-nums">
                          v{agent.latestVersion}
                        </span>
                      ) : null}
                      {agent.managed ? (
                        <Badge
                          variant="outline"
                          size="sm"
                          className="shrink-0 text-[10px]"
                        >
                          Managed
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                </div>

                {/* LLM-inferred summary (≤256 chars server-side); clamped so
                    cards stay even in the grid. */}
                <p
                  className="line-clamp-2 min-h-8 text-sm text-muted-foreground"
                  data-testid={`agent-blurb-${agent.slug}`}
                >
                  {blurbOf(agent)}
                </p>

                {/* Footer: lifecycle badge + deployment dot + primary action. */}
                <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Badge
                      variant={statusVariant(agent.status)}
                      size="sm"
                      className="capitalize"
                    >
                      {agent.status}
                    </Badge>
                    <StatusDot
                      status={deployed ? "success" : "neutral"}
                      pulse={deployed}
                      size="sm"
                      label={deployed ? "Deployed" : "Not deployed"}
                      className="text-xs text-muted-foreground"
                    />
                  </div>
                  {agent.launchHref ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 shrink-0"
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
                      className="h-7 shrink-0"
                      data-testid={`agent-edit-${agent.slug}`}
                      render={<Link href={agent.detailHref} />}
                    >
                      {agent.managed ? "View" : "Edit"}
                    </Button>
                  )}
                </div>

                {agent.agentKey ? (
                  // Dotted keys (oxagen.<ws>.<agent>) truncate in the MIDDLE so
                  // the distinguishing tail survives and a clip never reads as a
                  // typo; the full key stays in the title + copy affordance.
                  <CopyableId
                    value={agent.agentKey}
                    label="key"
                    max={28}
                    ellipsis="middle"
                  />
                ) : null}
              </article>
            );
          })}
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
