"use client";

/**
 * MemoryEvidenceAttachForm — Evidence attach panel for Knowledge → Memory
 * (web-app-2.0 Phase 2).
 *
 * Backs agent.memory_evidence.attach ("attach_memory_evidence"): records a
 * corroborating (or refuting) :Evidence node against a memory, moving its
 * confidence score by strength*100 (capped 100) and refreshing the decay
 * clock (schema §5/§7b) — how confidence recovers between decay passes
 * without waiting for a fresh citation.
 *
 * The contract's evidence signal is a closed sourceKind enum (CITATION /
 * HUMAN_CONFIRM / CODE_SCAN / AGENT_JUDGE / REPEAT_OBSERVATION) plus a
 * strength (0-1) and optional free-text detail — it does not carry a
 * structured graph-node or conversation-turn reference, so this form does not
 * fabricate one. The attach response returns only { evidenceId,
 * confidenceScore } — no human label for the memory — so the success
 * confirmation cites the memory by a `CopyableId` (the sanctioned home for a
 * bare id per the citation rule), never a raw UUID rendered as a primary
 * label.
 *
 * Independent of the main MemoriesClient list — its own Suspense boundary,
 * its own error state, fails open.
 */

import * as React from "react";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";

// ---------------------------------------------------------------------------
// Structural mirror of the server action type (this is a "use client" file —
// it never imports the "use server" actions module directly).
// ---------------------------------------------------------------------------

type EvidenceSourceKind =
  | "CITATION"
  | "HUMAN_CONFIRM"
  | "CODE_SCAN"
  | "AGENT_JUDGE"
  | "REPEAT_OBSERVATION";

type AttachMemoryEvidenceResult =
  | { ok: true; evidenceId: string; confidenceScore: number }
  | { ok: false; error: string };

export interface MemoryEvidenceAttachFormProps {
  orgSlug: string;
  workspaceSlug: string;
  attachEvidence: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
    sourceKind: EvidenceSourceKind;
    strength: number;
    detail?: string;
    refutes?: boolean;
  }) => Promise<AttachMemoryEvidenceResult>;
}

const SOURCE_KIND_OPTIONS: Array<{
  value: EvidenceSourceKind;
  label: string;
  hint: string;
}> = [
  {
    value: "HUMAN_CONFIRM",
    label: "Human confirmation",
    hint: "A person verified this by hand",
  },
  {
    value: "CITATION",
    label: "Citation",
    hint: "Cited again during a later execution",
  },
  {
    value: "CODE_SCAN",
    label: "Code scan",
    hint: "A static or automated scan found supporting evidence",
  },
  {
    value: "AGENT_JUDGE",
    label: "Agent judge",
    hint: "An LLM judge assessed this as correct",
  },
  {
    value: "REPEAT_OBSERVATION",
    label: "Repeat observation",
    hint: "Observed again independently",
  },
];

export function MemoryEvidenceAttachForm({
  orgSlug,
  workspaceSlug,
  attachEvidence,
}: MemoryEvidenceAttachFormProps) {
  const [memoryId, setMemoryId] = React.useState("");
  const [sourceKind, setSourceKind] =
    React.useState<EvidenceSourceKind>("HUMAN_CONFIRM");
  const [strength, setStrength] = React.useState(0.5);
  const [detail, setDetail] = React.useState("");
  const [refutes, setRefutes] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<{
    memoryId: string;
    evidenceId: string;
    confidenceScore: number;
  } | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedMemoryId = memoryId.trim();
    if (trimmedMemoryId.length === 0) {
      setError("Enter the id of the memory to attach evidence to.");
      return;
    }
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await attachEvidence({
        orgSlug,
        workspaceSlug,
        memoryId: trimmedMemoryId,
        sourceKind,
        strength,
        ...(detail.trim().length > 0 ? { detail: detail.trim() } : {}),
        refutes,
      });
      if (result.ok) {
        setSuccess({
          memoryId: trimmedMemoryId,
          evidenceId: result.evidenceId,
          confidenceScore: result.confidenceScore,
        });
        setDetail("");
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <section
      aria-labelledby="memory-evidence-heading"
      className="flex flex-col gap-4"
    >
      <div className="flex items-center gap-2">
        <FlaskConical
          className="h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <h2
          id="memory-evidence-heading"
          className="text-sm font-semibold text-foreground"
        >
          Attach Evidence
        </h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Strengthen (or refute) a memory&apos;s provenance. Supporting evidence
        pulls confidence up by strength and refreshes its decay clock; refuting
        evidence pulls it down.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-memory-id">Memory ID</Label>
          <Input
            id="evidence-memory-id"
            value={memoryId}
            onChange={(e) => setMemoryId(e.target.value)}
            placeholder="Paste the memory's copyable id"
            disabled={isPending}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-source-kind">Evidence source</Label>
          <Select
            value={sourceKind}
            onValueChange={(v) => setSourceKind(v as EvidenceSourceKind)}
            disabled={isPending}
          >
            <SelectTrigger
              id="evidence-source-kind"
              size="default"
              className="w-full"
              aria-label="Evidence source"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SOURCE_KIND_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <span className="font-medium">{opt.label}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {opt.hint}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="evidence-strength"
            className="text-sm text-foreground"
          >
            Strength:{" "}
            <span className="tabular-nums">{strength.toFixed(2)}</span>
          </label>
          <input
            id="evidence-strength"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={strength}
            onChange={(e) => setStrength(Number(e.target.value))}
            disabled={isPending}
            aria-label="Evidence strength"
            className="h-1 w-full cursor-pointer accent-primary"
          />
          <p className="text-[11px] text-muted-foreground">
            Confidence moves by strength × 100 (capped at 100).
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="evidence-refutes"
            checked={refutes}
            onCheckedChange={setRefutes}
            disabled={isPending}
          />
          <Label htmlFor="evidence-refutes">
            This evidence refutes the memory
          </Label>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="evidence-detail">Detail (optional)</Label>
          <Textarea
            id="evidence-detail"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="What did you observe or verify?"
            disabled={isPending}
          />
        </div>

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <div>
          <Button
            type="submit"
            size="sm"
            variant="gradient"
            disabled={isPending}
          >
            {isPending ? "Attaching…" : "Attach evidence"}
          </Button>
        </div>
      </form>

      {success && (
        <div className="flex flex-col gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
          <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Evidence attached
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
            <CopyableId value={success.memoryId} label="Memory" max={24} />
            <span>
              now at {Math.round(success.confidenceScore)}% confidence
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
