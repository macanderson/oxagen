"use client";

/**
 * MemoryCitationsPanel — Citations view for Knowledge → Memory (web-app-2.0
 * Phase 2).
 *
 * Backs agent.memory_citation.list ("list_memory_citations"), which is scoped
 * to a single execution — not a single memory — so this panel asks for an
 * execution id and lists every memory that execution cited: how much each one
 * shaped the output (influence: DECISIVE/CONTRIBUTING/CONSIDERED/IGNORED) and
 * whether any cited RULE was violated (compliance: VIOLATION). Each cited
 * memory is rendered with NodeRef — AgentMemory records are Neo4j nodes, so a
 * raw memoryId is never shown as the primary label (see node-ref.tsx).
 *
 * Independent of the main MemoriesClient list — its own Suspense boundary,
 * its own error/empty states, fails open.
 */

import * as React from "react";
import { Quote, ShieldAlert, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TruncatedText } from "@/components/ui/truncated-text";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";
import {
  EmptyState,
  ErrorState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

// ---------------------------------------------------------------------------
// Structural mirrors of the server action types (this is a "use client" file —
// it never imports the "use server" actions module directly; TS checks
// structurally instead, same convention as memories-client.tsx).
// ---------------------------------------------------------------------------

type Influence = "DECISIVE" | "CONTRIBUTING" | "CONSIDERED" | "IGNORED";
type Compliance = "COMPLIED" | "DISCRETION" | "VIOLATION" | "NA";

export interface MemoryCitation {
  citationId: string;
  memoryId: string;
  lesson: string;
  influence: Influence;
  compliance: Compliance;
  enforcementAtCite: number | null;
  expectedValue: string | null;
  observedValue: string | null;
  agentRationale: string | null;
}

type ListMemoryCitationsResult =
  | { ok: true; citations: MemoryCitation[] }
  | { ok: false; error: string };

export interface MemoryCitationsPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  listCitations: (input: {
    orgSlug: string;
    workspaceSlug: string;
    executionId: string;
    compliance?: Compliance;
    influenceIn?: Influence[];
  }) => Promise<ListMemoryCitationsResult>;
}

const INFLUENCE_CONFIG: Record<Influence, string> = {
  DECISIVE: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  CONTRIBUTING: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  CONSIDERED: "bg-zinc-400/20 text-zinc-600 dark:text-zinc-400",
  IGNORED: "bg-zinc-400/10 text-zinc-500 dark:text-zinc-500",
};

const COMPLIANCE_CONFIG: Record<Compliance, string> = {
  COMPLIED: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  DISCRETION: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  VIOLATION: "bg-red-500/15 text-red-700 dark:text-red-400",
  NA: "bg-zinc-400/20 text-zinc-600 dark:text-zinc-400",
};

/** Build a NodeRef-compatible citation for the memory a citation row refers
 * to — AgentMemory nodes live in Neo4j, so this never surfaces a raw id. The
 * property bag carries only detail the row's own columns don't already show
 * (influence, compliance, and rationale are rendered as their own cells), so
 * the inspect popover complements the row rather than repeating it. */
function citationNodeRef(citation: MemoryCitation): KnowledgeNodeRef {
  return {
    id: citation.memoryId,
    label: "AgentMemory",
    displayName: citation.lesson,
    properties: {
      enforcementAtCite: citation.enforcementAtCite,
      expectedValue: citation.expectedValue,
      observedValue: citation.observedValue,
    },
  };
}

export function MemoryCitationsPanel({
  orgSlug,
  workspaceSlug,
  listCitations,
}: MemoryCitationsPanelProps) {
  const [executionId, setExecutionId] = React.useState("");
  const [complianceFilter, setComplianceFilter] = React.useState<
    Compliance | "ALL"
  >("ALL");
  const [influenceFilter, setInfluenceFilter] = React.useState<Set<Influence>>(
    new Set(),
  );
  const [citations, setCitations] = React.useState<MemoryCitation[] | null>(
    null,
  );
  // Pre-submit validation error (blank id) vs. a failed lookup are rendered
  // differently — validationError never coexists with a search result.
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();
  const [hasSearched, setHasSearched] = React.useState(false);

  function runSearch() {
    const trimmed = executionId.trim();
    if (trimmed.length === 0) {
      setValidationError("Enter an execution id to look up citations.");
      return;
    }
    setValidationError(null);
    startTransition(async () => {
      const result = await listCitations({
        orgSlug,
        workspaceSlug,
        executionId: trimmed,
        ...(complianceFilter !== "ALL" ? { compliance: complianceFilter } : {}),
        ...(influenceFilter.size > 0
          ? { influenceIn: Array.from(influenceFilter) }
          : {}),
      });
      setHasSearched(true);
      if (result.ok) {
        setCitations(result.citations);
        setSearchError(null);
      } else {
        setCitations(null);
        setSearchError(result.error);
      }
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch();
  }

  const violationCount =
    citations?.filter((c) => c.compliance === "VIOLATION").length ?? 0;

  return (
    <section
      aria-labelledby="memory-citations-heading"
      className="flex flex-col gap-4"
    >
      <div className="flex items-center gap-2">
        <Quote className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2
          id="memory-citations-heading"
          className="text-sm font-semibold text-foreground"
        >
          Memory Citations
        </h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Look up an execution to see which memories it cited, how much each one
        shaped the outcome, and any rule violations recorded against them.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="citations-execution-id">Execution ID</Label>
          <Input
            id="citations-execution-id"
            value={executionId}
            onChange={(e) => setExecutionId(e.target.value)}
            placeholder="exec_..."
            disabled={isPending}
            className="w-64"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="citations-compliance-filter">Compliance</Label>
          <Select
            value={complianceFilter}
            onValueChange={(v) => setComplianceFilter(v as Compliance | "ALL")}
            disabled={isPending}
          >
            <SelectTrigger
              id="citations-compliance-filter"
              size="default"
              className="w-40"
              aria-label="Filter by compliance"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="ALL">All outcomes</SelectItem>
              <SelectItem value="COMPLIED">Complied</SelectItem>
              <SelectItem value="DISCRETION">Discretion</SelectItem>
              <SelectItem value="VIOLATION">Violation</SelectItem>
              <SelectItem value="NA">N/A</SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">Influence</span>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="Filter by influence"
          >
            {(Object.keys(INFLUENCE_CONFIG) as Influence[]).map((influence) => {
              const active = influenceFilter.has(influence);
              return (
                <button
                  key={influence}
                  type="button"
                  aria-pressed={active}
                  disabled={isPending}
                  onClick={() =>
                    setInfluenceFilter((prev) => {
                      const next = new Set(prev);
                      if (next.has(influence)) next.delete(influence);
                      else next.add(influence);
                      return next;
                    })
                  }
                  className={`rounded-md border px-2 py-1 text-[10px] font-medium transition-colors ${
                    active
                      ? "border-transparent " + INFLUENCE_CONFIG[influence]
                      : "border-border/60 text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {influence}
                </button>
              );
            })}
          </div>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={isPending}>
          <Search className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          {isPending ? "Loading…" : "Load citations"}
        </Button>
      </form>

      {validationError && (
        <p role="alert" className="text-xs text-destructive">
          {validationError}
        </p>
      )}

      {violationCount > 0 && (
        <div className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
          {violationCount} rule violation{violationCount === 1 ? "" : "s"}{" "}
          recorded in this execution.
        </div>
      )}

      {!hasSearched && !searchError && (
        <EmptyState
          icon={Quote}
          title="No execution looked up yet"
          description="Enter an execution id above to see which memories it cited."
        />
      )}

      {hasSearched && !searchError && citations && citations.length === 0 && (
        <EmptyState
          icon={Quote}
          title="No citations recorded"
          description="This execution did not cite any memories, or none match the selected filter."
        />
      )}

      {searchError && (
        <ErrorState
          title="Failed to load citations"
          description={searchError}
          retry={runSearch}
        />
      )}

      {citations && citations.length > 0 && (
        <Table density="compact" className="min-w-[36rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Memory</TableHead>
              <TableHead>Influence</TableHead>
              <TableHead>Compliance</TableHead>
              <TableHead>Rationale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {citations.map((citation) => (
              <TableRow key={citation.citationId}>
                <TableCell className="max-w-[18rem]">
                  <NodeRef node={citationNodeRef(citation)} />
                </TableCell>
                <TableCell>
                  <Badge
                    className={`${INFLUENCE_CONFIG[citation.influence]} border-0 text-[10px] font-medium`}
                  >
                    {citation.influence}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    className={`${COMPLIANCE_CONFIG[citation.compliance]} border-0 text-[10px] font-medium`}
                  >
                    {citation.compliance}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[20rem]">
                  {citation.agentRationale ? (
                    <TruncatedText
                      text={citation.agentRationale}
                      lines={1}
                      markdown={false}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
