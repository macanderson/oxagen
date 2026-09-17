/**
 * graph-table-view.tsx — paginated, searchable tabular view of graph nodes.
 *
 * Backed directly by `graph.node.list` (server-side pagination + text search),
 * so it scales to large graphs without shipping every node to the browser. Rows
 * show the human display name, type, a copyable id, and creation time; clicking
 * a row opens the node detail panel. Honours the global node-type visibility by
 * passing the visible label set to the server.
 */

"use client";

import * as React from "react";
import { Loader2, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyableId } from "./copyable-id";
import { fetchNodes, type TenantSlugs } from "./api-client";
import type { ExplorerNode } from "./types";
import { colorForLabel } from "./lib/colors";
import { formatPropertyValue } from "./lib/format";

const PAGE_SIZE = 25;

export interface GraphTableViewProps {
  tenant: TenantSlugs;
  /** Visible node labels — when set (and not all), filters the server query. */
  visibleLabels?: string[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

interface TableState {
  status: "loading" | "ready" | "error";
  nodes: ExplorerNode[];
  total: number;
  hasMore: boolean;
}

export function GraphTableView({
  tenant,
  visibleLabels,
  selectedNodeId,
  onSelectNode,
}: GraphTableViewProps) {
  const [rawQuery, setRawQuery] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const [state, setState] = React.useState<TableState>({
    status: "loading",
    nodes: [],
    total: 0,
    hasMore: false,
  });

  // Debounce the search box so each keystroke does not fire a request.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setQuery(rawQuery.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // The parent rebuilds `visibleLabels` inline on every render, so its identity
  // changes even when the label set does not. Re-key it on the joined value so
  // the fetch effect below fires on a real filter change — not on every parent
  // re-render (hover, selection), which otherwise aborts and refetches the page.
  const labelsKey = visibleLabels ? visibleLabels.join(",") : "";
  const labels = React.useMemo(
    () => visibleLabels,
    // labelsKey IS the value-identity of visibleLabels; depending on the array
    // itself is exactly the bug this memo exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [labelsKey],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((s) => ({ ...s, status: "loading" }));
    fetchNodes(
      tenant,
      {
        ...(query ? { query } : {}),
        ...(labels && labels.length > 0 ? { labels } : {}),
        limit: PAGE_SIZE,
        offset,
      },
      controller.signal,
    )
      .then((payload) => {
        if (!active) return;
        setState({
          status: "ready",
          nodes: payload.nodes,
          total: payload.total,
          hasMore: payload.hasMore,
        });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setState({ status: "error", nodes: [], total: 0, hasMore: false });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [tenant, query, offset, labels]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(state.total / PAGE_SIZE));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative max-w-sm flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search nodes…"
            aria-label="Search nodes"
            className="pl-8"
          />
        </div>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
          {state.total.toLocaleString()} {state.total === 1 ? "node" : "nodes"}
        </span>
      </div>

      {/* overflow-auto contains horizontal scrolling here (min-w on the table
          keeps columns readable on phones) instead of overflowing the page. */}
      <div className="relative min-h-0 flex-1 overflow-auto overscroll-x-contain">
        {state.status === "loading" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
            <Loader2
              className="size-5 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          </div>
        )}
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead className="sticky top-0 z-[1] bg-card">
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Type</th>
              <th className="px-4 py-2 font-medium">ID</th>
              <th className="px-4 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {state.status === "error" && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-sm text-destructive"
                >
                  Failed to load nodes.
                </td>
              </tr>
            )}
            {state.status !== "error" &&
              state.nodes.length === 0 &&
              state.status === "ready" && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    No nodes match.
                  </td>
                </tr>
              )}
            {state.nodes.map((n) => (
              <tr
                key={n.id}
                onClick={() => onSelectNode(n.id)}
                aria-selected={selectedNodeId === n.id}
                className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/40 aria-selected:bg-primary/5"
              >
                <td className="max-w-xs px-4 py-2">
                  <span
                    className="block truncate font-medium text-foreground"
                    title={n.displayName}
                  >
                    {n.displayName}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <Badge variant="outline" size="sm" className="gap-1">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: colorForLabel(n.label) }}
                      aria-hidden="true"
                    />
                    {n.label}
                  </Badge>
                </td>
                <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                  <CopyableId value={n.id} max={14} />
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">
                  {n.createdAt ? formatPropertyValue(n.createdAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
        <span className="text-xs text-muted-foreground tabular-nums">
          Page {page} of {pageCount}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0 || state.status === "loading"}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            startIcon={<ChevronLeft className="size-3.5" />}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!state.hasMore || state.status === "loading"}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            endIcon={<ChevronRight className="size-3.5" />}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
