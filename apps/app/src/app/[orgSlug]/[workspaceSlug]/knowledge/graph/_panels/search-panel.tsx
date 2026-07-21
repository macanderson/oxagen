"use client";

/**
 * search-panel.tsx — fuzzy + semantic node search (Knowledge → Graph → Search tab).
 *
 * "Semantic" off → graph.node.search ("search_nodes"): lexical substring match
 * on displayName/description.
 * "Semantic" on  → graph.search ("search_graph"): NL/embedding similarity
 * search across the whole graph (entities, code, memories, executions, docs).
 *
 * Debounced 300ms so keystrokes don't hammer the server action.
 */

import * as React from "react";
import { Search, Sparkles } from "lucide-react";
import { SearchInput } from "@/components/ui/search-input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { searchNodesAction, semanticSearchAction } from "../actions";
import { fromSearchNode, fromSemanticResult } from "./node-ref-adapters";
import { GraphResultRow } from "./graph-result-row";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";

const DEBOUNCE_MS = 300;

interface ResultItem {
  ref: KnowledgeNodeRef;
  score: number;
}

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; results: ResultItem[] };

export interface SearchPanelProps {
  orgSlug: string;
  workspaceSlug: string;
}

export function SearchPanel({ orgSlug, workspaceSlug }: SearchPanelProps) {
  const [query, setQuery] = React.useState("");
  const [semantic, setSemantic] = React.useState(false);
  const [state, setState] = React.useState<SearchState>({ status: "idle" });

  React.useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      void (async () => {
        if (semantic) {
          const res = await semanticSearchAction({
            orgSlug,
            workspaceSlug,
            query: trimmed,
            limit: 20,
          });
          if (!res.ok) {
            setState({ status: "error", message: res.error });
            return;
          }
          setState({
            status: "ready",
            results: res.results.map((r) => ({
              ref: fromSemanticResult(r),
              score: r.score,
            })),
          });
          return;
        }
        const res = await searchNodesAction({
          orgSlug,
          workspaceSlug,
          query: trimmed,
          limit: 20,
        });
        if (!res.ok) {
          setState({ status: "error", message: res.error });
          return;
        }
        setState({
          status: "ready",
          results: res.nodes.map((n) => ({
            ref: fromSearchNode(n),
            score: n.score,
          })),
        });
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, semantic, orgSlug, workspaceSlug]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <SearchInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery("")}
        placeholder="Search nodes by name or description…"
        aria-label="Search graph nodes"
      />

      <div className="flex items-center gap-2">
        <Switch
          id="semantic-search-toggle"
          checked={semantic}
          onCheckedChange={setSemantic}
        />
        <Label
          htmlFor="semantic-search-toggle"
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Sparkles className="size-3.5" aria-hidden="true" />
          Semantic search
        </Label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "idle" ? (
          <EmptyState
            icon={Search}
            title="Type to search"
            description="Search by name, description, or (with Semantic on) meaning."
          />
        ) : state.status === "loading" ? (
          <LoadingState variant="table" />
        ) : state.status === "error" ? (
          <ErrorState title="Search failed" description={state.message} />
        ) : state.results.length === 0 ? (
          <EmptyState
            icon={Search}
            title="No matches"
            description={`Nothing matched "${query.trim()}".`}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {state.results.map((item) => (
              <GraphResultRow
                key={`${item.ref.id ?? item.ref.displayName}`}
                node={item.ref}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                meta={
                  <Badge
                    variant="muted"
                    size="sm"
                    className="shrink-0 tabular-nums"
                  >
                    {item.score.toFixed(2)}
                  </Badge>
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
