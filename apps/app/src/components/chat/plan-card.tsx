"use client";
import * as React from "react";
import { ChevronDown, ChevronRight, ListChecks, MoveRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { PlanDecision, PlanStep } from "./stream-event-types";

export interface PlanCardProps {
  planId: string;
  title: string;
  steps: PlanStep[];
  rationale?: string;
  status: "pending" | PlanDecision;
  onResolve?: (
    planId: string,
    decision: PlanDecision,
    amendedSteps?: PlanStep[],
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function PlanCard({ planId, title, steps, rationale, status, onResolve }: PlanCardProps) {
  const [rationaleOpen, setRationaleOpen] = React.useState(false);
  const [amending, setAmending] = React.useState(false);
  // v1 amend UX is a raw JSON textarea — flag for follow-up: proper
  // per-step editor with capability picker + drag-to-reorder dependencies.
  const [amendedText, setAmendedText] = React.useState(() => JSON.stringify(steps, null, 2));
  const [pending, setPending] = React.useState<PlanDecision | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [optimistic, setOptimistic] = React.useState<PlanDecision | "pending">(status);

  const handle = async (decision: PlanDecision) => {
    if (!onResolve) return;
    setError(null);
    setPending(decision);
    let amended: PlanStep[] | undefined;
    if (decision === "amended") {
      try {
        amended = JSON.parse(amendedText) as PlanStep[];
      } catch (e) {
        setError("Amended steps are not valid JSON");
        setPending(null);
        return;
      }
    }
    setOptimistic(decision);
    const res = await onResolve(planId, decision, amended);
    setPending(null);
    if (!res.ok) {
      setOptimistic(status);
      setError(res.error ?? "Failed to resolve plan");
    } else if (decision !== "amended") {
      setAmending(false);
    }
  };

  const settled = optimistic !== "pending";

  return (
    <div className="glass-panel my-2 space-y-3 p-4 animate-in">
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-accent" />
        <h4 className="text-sm font-semibold">{title}</h4>
        <Badge variant="muted" className="ml-auto">
          {settled ? optimistic : "awaiting approval"}
        </Badge>
      </div>

      <ol className="space-y-2">
        {steps.map((step, idx) => (
          <li key={step.id} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[10px] font-semibold text-accent tabular-nums">
              {idx + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{step.summary}</span>
                {step.capability ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {step.capability}
                  </Badge>
                ) : null}
                {step.dependsOn.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <MoveRight className="h-3 w-3" />
                    {step.dependsOn.join(", ")}
                  </span>
                ) : null}
              </div>
              {step.intent ? (
                <p className="text-xs text-muted-foreground">{step.intent}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {rationale ? (
        <div>
          <button
            type="button"
            onClick={() => setRationaleOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {rationaleOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Rationale
          </button>
          {rationaleOpen ? (
            <p className="mt-1 whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs">{rationale}</p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {amending && !settled ? (
        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Amended steps (JSON)
          </div>
          <Textarea
            value={amendedText}
            onChange={(e) => setAmendedText(e.target.value)}
            rows={8}
            className="font-mono text-xs"
          />
        </div>
      ) : null}

      {!settled ? (
        <div className="flex items-center justify-end gap-2">
          {amending ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAmending(false)}
                disabled={pending !== null}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => handle("amended")} disabled={pending !== null}>
                {pending === "amended" ? "Submitting…" : "Submit amendment"}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAmending(true)}
                disabled={pending !== null}
              >
                Amend
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handle("denied")}
                disabled={pending !== null}
              >
                Deny
              </Button>
              <Button size="sm" onClick={() => handle("approved")} disabled={pending !== null}>
                {pending === "approved" ? "Approving…" : "Approve"}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
