"use client";

/**
 * MemoryPromotionQueue — Promotion candidates queue for Knowledge → Memory
 * (web-app-2.0 Phase 2).
 *
 * The dedicated, full-queue review surface for agent.memory.promotion.
 * candidates ("list_memory_promotions") — every OBSERVATION currently ripe
 * for promotion (up to the API's cap of 25), each with an explicit
 * human-confirmation step before promoting via the existing promote_memory
 * capability. This complements (does not replace) the inline "Suggested to
 * promote" nudge already built into MemoriesClient, which only surfaces the
 * top 3 candidates inline above the list.
 *
 * FACT-type promotions require explicit human confirmation before taking
 * effect (spec.md): the confirm step for FACT gates the button behind a
 * checked "I confirm…" acknowledgement, not just a rationale.
 *
 * Independent of the main MemoriesClient list — its own Suspense boundary
 * (via the server section), its own error/empty states, fails open.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowUpCircle, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { NodeRef } from "@/components/knowledge/graph/node-ref";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/semantic.edge.list";
import {
  EmptyState,
  ErrorState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { CLASS_CONFIG } from "./memory-kinds";
import { RationalePicker, type SuggestRationalesFn } from "./rationale-picker";

// ---------------------------------------------------------------------------
// Structural mirrors of the server action types (this is a "use client" file
// — it never imports the "use server" actions module directly).
// ---------------------------------------------------------------------------

export interface PromotionCandidate {
  id: string;
  publicId: string;
  lesson: string;
  memoryKind: string;
  citationCount: number;
  influenceCount: number;
  confidenceScore: number;
}

type PromoteTarget = "RULE" | "FACT";

type PromoteMemoryResult =
  | { ok: true; memory: unknown }
  | { ok: false; error: string };

type DismissPromotionResult =
  | { ok: true; memoryId: string; dismissed: boolean }
  | { ok: false; error: string };

export interface MemoryPromotionQueueProps {
  initialCandidates: PromotionCandidate[];
  loadError: string | null;
  orgSlug: string;
  workspaceSlug: string;
  promoteMemory: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
    toClass: PromoteTarget;
    enforcementScore?: number;
    rationale?: string;
    basedOnEvidenceIds?: string[];
  }) => Promise<PromoteMemoryResult>;
  /** Durably removes (or, with restore:true, restores) a candidate from the queue. */
  dismissPromotion: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
    restore?: boolean;
  }) => Promise<DismissPromotionResult>;
  /** Drafts candidate rationales for the RationalePicker select. */
  suggestRationales: SuggestRationalesFn;
}

function candidateNodeRef(candidate: PromotionCandidate): KnowledgeNodeRef {
  return {
    id: candidate.id,
    label: "AgentMemory",
    displayName: candidate.lesson,
    properties: {
      memoryKind: candidate.memoryKind,
      citationCount: candidate.citationCount,
      influenceCount: candidate.influenceCount,
      confidenceScore: candidate.confidenceScore,
      publicId: candidate.publicId,
    },
  };
}

export function MemoryPromotionQueue({
  initialCandidates,
  loadError,
  orgSlug,
  workspaceSlug,
  promoteMemory,
  dismissPromotion,
  suggestRationales,
}: MemoryPromotionQueueProps) {
  const router = useRouter();
  const toast = useToast();
  const [candidates, setCandidates] = React.useState(initialCandidates);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  function handlePromoted(memoryId: string) {
    setCandidates((prev) => prev.filter((c) => c.id !== memoryId));
    setExpandedId(null);
    router.refresh();
  }

  // Optimistic removal + durable dismiss, with an Undo toast that restores
  // the candidate (calling dismiss again with restore:true) if the human
  // changes their mind. On a failed dismiss call the card comes right back.
  function handleDismissed(candidate: PromotionCandidate) {
    setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
    setExpandedId(null);

    void dismissPromotion({
      orgSlug,
      workspaceSlug,
      memoryId: candidate.id,
    }).then((result) => {
      if (!result.ok) {
        setCandidates((prev) =>
          prev.some((c) => c.id === candidate.id) ? prev : [candidate, ...prev],
        );
        toast.add({
          title: "Couldn't dismiss",
          description: result.error,
          type: "error",
        });
        return;
      }
      toast.add({
        title: "Dismissed from promotion queue",
        description: candidate.lesson,
        type: "success",
        actionProps: {
          children: "Undo",
          onClick: () => {
            void dismissPromotion({
              orgSlug,
              workspaceSlug,
              memoryId: candidate.id,
              restore: true,
            }).then((restoreResult) => {
              if (restoreResult.ok) {
                setCandidates((prev) =>
                  prev.some((c) => c.id === candidate.id)
                    ? prev
                    : [candidate, ...prev],
                );
              } else {
                toast.add({
                  title: "Couldn't restore",
                  description: restoreResult.error,
                  type: "error",
                });
              }
            });
          },
        },
      });
    });
  }

  return (
    <section
      aria-labelledby="memory-promotion-queue-heading"
      className="flex flex-col gap-4"
    >
      <div className="flex items-center gap-2">
        <ListChecks
          className="h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <h2
          id="memory-promotion-queue-heading"
          className="text-sm font-semibold text-foreground"
        >
          Promotion Candidates
        </h2>
        {candidates.length > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
            {candidates.length}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Memories flagged as promotion-worthy by citation pressure, awaiting
        review. Promoting to Fact requires explicit confirmation — it represents
        a human-confirmed, org-wide truth, not just policy.
      </p>

      {loadError && (
        <ErrorState
          title="Failed to load promotion candidates"
          description={loadError}
          retry={() => router.refresh()}
        />
      )}

      {!loadError && candidates.length === 0 && (
        <EmptyState
          icon={ListChecks}
          title="No promotion candidates"
          description="Nothing is currently flagged as promotion-worthy. Citation pressure builds over time — check back later."
        />
      )}

      {!loadError && candidates.length > 0 && (
        <ul className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <li
              key={candidate.id}
              className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <NodeRef node={candidateNodeRef(candidate)} />
                {expandedId !== candidate.id && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setExpandedId(candidate.id)}
                    aria-label={`Review promotion candidate: ${candidate.lesson}`}
                  >
                    <ArrowUpCircle
                      className="h-3 w-3 mr-1.5"
                      aria-hidden="true"
                    />
                    Review
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span>
                  {candidate.citationCount} citation
                  {candidate.citationCount === 1 ? "" : "s"}
                </span>
                <span>{candidate.influenceCount} influential</span>
                <span>{Math.round(candidate.confidenceScore)}% confidence</span>
              </div>
              {expandedId === candidate.id && (
                <PromotionConfirmFlow
                  candidate={candidate}
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                  promoteMemory={promoteMemory}
                  suggestRationales={suggestRationales}
                  onPromoted={() => handlePromoted(candidate.id)}
                  onCancel={() => setExpandedId(null)}
                  onDismiss={() => handleDismissed(candidate)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-candidate confirm flow — choose RULE or FACT, provide a rationale, and
// (for FACT) explicitly acknowledge the promotion before the confirm button
// is enabled.
// ---------------------------------------------------------------------------

function PromotionConfirmFlow({
  candidate,
  orgSlug,
  workspaceSlug,
  promoteMemory,
  suggestRationales,
  onPromoted,
  onCancel,
  onDismiss,
}: {
  candidate: PromotionCandidate;
  orgSlug: string;
  workspaceSlug: string;
  promoteMemory: MemoryPromotionQueueProps["promoteMemory"];
  suggestRationales: SuggestRationalesFn;
  onPromoted: () => void;
  onCancel: () => void;
  /** Durably removes this candidate from the queue (distinct from onCancel, which just collapses this form). */
  onDismiss: () => void;
}) {
  const [target, setTarget] = React.useState<PromoteTarget | null>(null);
  const [enforcementScore, setEnforcementScore] = React.useState(50);
  const [rationale, setRationale] = React.useState("");
  const [factConfirmed, setFactConfirmed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function cancel() {
    setTarget(null);
    setRationale("");
    setFactConfirmed(false);
    setError(null);
    onCancel();
  }

  function confirmPromote() {
    if (!target) return;
    if (target === "FACT" && !factConfirmed) {
      setError("Confirm this is a durable, org-wide fact before promoting.");
      return;
    }
    setError(null);
    const trimmedRationale = rationale.trim();
    startTransition(async () => {
      const result = await promoteMemory({
        orgSlug,
        workspaceSlug,
        memoryId: candidate.id,
        toClass: target,
        ...(target === "RULE" ? { enforcementScore } : {}),
        ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
      });
      if (result.ok) {
        onPromoted();
      } else {
        setError(result.error);
      }
    });
  }

  if (!target) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={() => setTarget("RULE")}>
          <ArrowUpCircle className="h-3 w-3 mr-1.5" aria-hidden="true" />
          Promote to {CLASS_CONFIG.RULE.label}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setTarget("FACT")}>
          <ArrowUpCircle className="h-3 w-3 mr-1.5" aria-hidden="true" />
          Promote to {CLASS_CONFIG.FACT.label}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium text-foreground">
        Promote to {CLASS_CONFIG[target].label}
      </p>

      {target === "RULE" ? (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`queue-promote-enforcement-${candidate.id}`}
            className="text-[11px] text-muted-foreground"
          >
            Enforcement:{" "}
            <span className="tabular-nums">{enforcementScore}</span>
          </label>
          <input
            id={`queue-promote-enforcement-${candidate.id}`}
            type="range"
            min="1"
            max="100"
            value={enforcementScore}
            onChange={(e) => setEnforcementScore(Number(e.target.value))}
            disabled={isPending}
            aria-label="Enforcement score"
            className="h-1 w-full cursor-pointer accent-primary"
          />
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
          <input
            id={`queue-promote-fact-confirm-${candidate.id}`}
            type="checkbox"
            checked={factConfirmed}
            onChange={(e) => setFactConfirmed(e.target.checked)}
            disabled={isPending}
            className="mt-0.5"
          />
          <label
            htmlFor={`queue-promote-fact-confirm-${candidate.id}`}
            className="text-[11px] text-foreground"
          >
            I confirm this is a durable, org-wide fact — always fully enforced
            (100) and human-confirmed, not just policy. This cannot be casually
            undone.
          </label>
        </div>
      )}

      <RationalePicker
        idPrefix={`queue-promote-${candidate.id}`}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        memoryId={candidate.id}
        toClass={target}
        value={rationale}
        onChange={setRationale}
        disabled={isPending}
        suggestRationales={suggestRationales}
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="gradient"
          onClick={confirmPromote}
          disabled={isPending || (target === "FACT" && !factConfirmed)}
        >
          {isPending
            ? "Promoting…"
            : `Confirm promote to ${CLASS_CONFIG[target].label}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
