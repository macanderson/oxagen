"use client";

/**
 * browse-panel.tsx — paginated node browser (Knowledge → Graph → Browse tab).
 *
 * Label filter chips come from `graphStatsAction({ includeByType: true })`'s
 * `nodesByLabel` breakdown (lifted from the parent GraphSidePanel) — list_nodes
 * itself has no "distinct labels" capability, so stats-by-type is the only
 * source for which chips to offer.
 *
 * Sort is CLIENT-SIDE over the current page only: graph.node.list has no
 * `sortBy` input and its output carries no "degree" field, so "sortable by
 * recency/degree" (per the spec) is only achievable as "recency" (by
 * `createdAt`, when present) and "name" — there is no degree data to sort by
 * at all given the current contract shape.
 *
 * Empty states: a genuinely empty graph (zero total, no filter applied) shows
 * the spec's "Connect a source" prompt, linking to Sources — this is the ONE
 * place that empty state lives (see graph-side-panel.tsx's own doc comment
 * for why it isn't a workspace-wide gate over Search/Query too). A filtered
 * page with zero matches shows the narrower "No nodes match this filter"
 * instead, since the graph itself isn't empty.
 */

import * as React from "react";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
  Boxes,
  Network,
} from "lucide-react";
import type { GraphNodeListOutput } from "@oxagen/oxagen/contracts/graph.node.list";
import type { OntologyNeighborsOutput } from "@oxagen/oxagen/contracts/ontology.neighbors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { workspace } from "@/lib/routes";
import { listNodesAction, ontologyNeighborsAction } from "../actions";
import { fromListNode, fromNeighbor } from "./node-ref-adapters";
import { GraphResultRow } from "./graph-result-row";

const PAGE_SIZE = 25;

type SortMode = "recent" | "name";

interface NeighborState {
  status: "loading" | "ready" | "error";
  neighbors: OntologyNeighborsOutput["neighbors"];
  error?: string;
}

export interface BrowsePanelProps {
  orgSlug: string;
  workspaceSlug: string;
  /** Label chip choices — derived by the parent from graph.stats's nodesByLabel. */
  availableLabels: string[];
  /**
   * Called whenever the active label filter changes, so a parent can mirror
   * the panel's scope. Optional and currently unused by `GraphSidePanel`.
   */
  onLabelsChange?: (labels: string[]) => void;
}

export function BrowsePanel({
  orgSlug,
  workspaceSlug,
  availableLabels,
  onLabelsChange,
}: BrowsePanelProps) {
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const [sort, setSort] = React.useState<SortMode>("recent");
  const [offset, setOffset] = React.useState(0);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = React.useState("");
  const [rows, setRows] = React.useState<GraphNodeListOutput["nodes"]>([]);
  const [total, setTotal] = React.useState(0);
  const [hasMore, setHasMore] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [neighborState, setNeighborState] = React.useState<
    Record<string, NeighborState>
  >({});

  const load = React.useCallback(async () => {
    setStatus("loading");
    const res = await listNodesAction({
      orgSlug,
      workspaceSlug,
      ...(selectedLabels.length > 0 ? { labels: selectedLabels } : {}),
      limit: PAGE_SIZE,
      offset,
    });
    if (!res.ok) {
      setError(res.error);
      setStatus("error");
      return;
    }
    setRows(res.nodes);
    setTotal(res.total);
    setHasMore(res.hasMore);
    setStatus("ready");
  }, [orgSlug, workspaceSlug, selectedLabels, offset]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    onLabelsChange?.(selectedLabels);
  }, [selectedLabels, onLabelsChange]);

  const toggleLabel = React.useCallback((label: string) => {
    setOffset(0);
    setSelectedLabels((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );
  }, []);

  const toggleExpand = React.useCallback((nodeId: string) => {
    setExpandedId((prev) => (prev === nodeId ? null : nodeId));
  }, []);

  // Which node ids we've already kicked off a neighbor fetch for. Keying the
  // "fetch once per node" guard on a ref (not on `neighborState`) is load-
  // bearing: if the effect DEPENDED on `neighborState`, writing the "loading"
  // placeholder below would change its identity and re-run the effect
  // synchronously, and that re-run's cleanup would abort the still-in-flight
  // fetch (`active = false`) — so the "ready" result was never written and
  // neighbors never appeared. The ref lets the effect depend only on
  // `expandedId` + tenant, so the loading write can't cancel its own fetch.
  const requestedNeighborsRef = React.useRef<Set<string>>(new Set());
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (!expandedId || requestedNeighborsRef.current.has(expandedId)) return;
    const nodeId = expandedId;
    requestedNeighborsRef.current.add(nodeId);
    setNeighborState((prev) => ({
      ...prev,
      [nodeId]: { status: "loading", neighbors: [] },
    }));
    void (async () => {
      const res = await ontologyNeighborsAction({
        orgSlug,
        workspaceSlug,
        nodeId,
        limit: 25,
      });
      if (!mountedRef.current) return;
      // On failure, drop the guard so a later re-expand retries instead of
      // sticking on the error state forever.
      if (!res.ok) requestedNeighborsRef.current.delete(nodeId);
      setNeighborState((prev) => ({
        ...prev,
        [nodeId]: res.ok
          ? { status: "ready", neighbors: res.neighbors }
          : { status: "error", neighbors: [], error: res.error },
      }));
    })();
  }, [expandedId, orgSlug, workspaceSlug]);

  const sortedRows = React.useMemo(() => {
    const copy = [...rows];
    if (sort === "name") {
      copy.sort((a, b) => a.displayName.localeCompare(b.displayName));
    } else {
      copy.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    }
    return copy;
  }, [rows, sort]);

  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + rows.length, total);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {availableLabels.length > 0 ? (
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Filter by label"
        >
          {availableLabels.map((label) => {
            const active = selectedLabels.includes(label);
            return (
              <Badge
                key={label}
                variant={active ? "brand" : "outline"}
                render={
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleLabel(label)}
                  />
                }
                className="cursor-pointer"
              >
                {label}
              </Badge>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {status === "ready"
            ? `${rangeStart}–${rangeEnd} of ${total.toLocaleString()}`
            : null}
        </span>
        <Select value={sort} onValueChange={(v) => v && setSort(v as SortMode)}>
          <SelectTrigger size="sm" className="w-36" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="recent">Recently added</SelectItem>
            <SelectItem value="name">Name (A–Z)</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === "loading" ? (
          <LoadingState variant="table" />
        ) : status === "error" ? (
          <ErrorState
            title="Couldn't load nodes"
            description={error}
            retry={() => void load()}
          />
        ) : sortedRows.length === 0 &&
          total === 0 &&
          selectedLabels.length === 0 ? (
          <EmptyState
            icon={Network}
            title="Connect a source"
            description="No nodes have been ingested into this workspace's graph yet."
            action={
              <Button
                size="sm"
                render={
                  <Link
                    href={workspace.knowledge.sources({
                      orgSlug,
                      workspaceSlug,
                    })}
                  />
                }
              >
                Go to Sources
              </Button>
            }
          />
        ) : sortedRows.length === 0 ? (
          <EmptyState icon={Boxes} title="No nodes match this filter" />
        ) : (
          <div className="flex flex-col gap-1.5">
            {sortedRows.map((node) => {
              const state =
                expandedId === node.id ? neighborState[node.id] : undefined;
              return (
                <GraphResultRow
                  key={node.id}
                  node={fromListNode(node)}
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                  expand={{
                    expanded: expandedId === node.id,
                    loading: state?.status === "loading",
                    onToggle: () => toggleExpand(node.id),
                  }}
                >
                  {state?.status === "ready" ? (
                    state.neighbors.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No connected entities.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {state.neighbors.map((n) => (
                          <GraphResultRow
                            key={`${n.nodeId}:${n.edgeType}:${n.direction}`}
                            node={fromNeighbor(n)}
                            orgSlug={orgSlug}
                            workspaceSlug={workspaceSlug}
                            className="border-none"
                          />
                        ))}
                      </div>
                    )
                  ) : state?.status === "error" ? (
                    <p className="text-xs text-destructive">{state.error}</p>
                  ) : null}
                </GraphResultRow>
              );
            })}
          </div>
        )}
      </div>

      {status === "ready" && total > PAGE_SIZE ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-2">
          <Button
            size="sm"
            variant="outline"
            startIcon={<ChevronLeft className="size-3.5" />}
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            endIcon={<ChevronRightIcon className="size-3.5" />}
            disabled={!hasMore}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}
