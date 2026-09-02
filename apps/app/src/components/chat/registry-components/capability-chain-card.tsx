"use client";
import * as React from "react";
import {
  Workflow,
  CheckCircle2,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TruncatedText } from "@/components/ui/truncated-text";
import { StructuredValue } from "../structured-value";

/**
 * capability-chain-card — renders agent.compose output: the synthesized summary,
 * the goal, and the ordered chain of steps with per-step status, rationale, and
 * an expandable view of the actual input/output for that step. This is the
 * chain-of-thought view for a composed capability run.
 *
 * componentId: "capability-chain-card"
 */

type StepStatus = "success" | "error" | "skipped";

interface ChainStep {
  id: string;
  capability: string;
  rationale: string;
  status: StepStatus;
  input: Record<string, unknown> | null;
  output?: unknown;
  error?: string;
  durationMs: number;
}

interface CapabilityChainCardProps {
  capability?: string;
  output?: unknown;
}

interface ChainShape {
  goal: string;
  summary: string;
  executed: boolean;
  steps: ChainStep[];
}

function readChain(output: unknown): ChainShape {
  const o =
    typeof output === "object" && output !== null
      ? (output as Record<string, unknown>)
      : {};
  const steps = Array.isArray(o.steps)
    ? o.steps.flatMap((s): ChainStep[] => {
        if (typeof s !== "object" || s === null) return [];
        const ss = s as Record<string, unknown>;
        const status: StepStatus =
          ss.status === "success" ||
          ss.status === "error" ||
          ss.status === "skipped"
            ? ss.status
            : "skipped";
        return [
          {
            id: typeof ss.id === "string" ? ss.id : "",
            capability:
              typeof ss.capability === "string" ? ss.capability : "unknown",
            rationale: typeof ss.rationale === "string" ? ss.rationale : "",
            status,
            input:
              ss.input &&
              typeof ss.input === "object" &&
              !Array.isArray(ss.input)
                ? (ss.input as Record<string, unknown>)
                : null,
            output: ss.output,
            error: typeof ss.error === "string" ? ss.error : undefined,
            durationMs: typeof ss.durationMs === "number" ? ss.durationMs : 0,
          },
        ];
      })
    : [];
  return {
    goal: typeof o.goal === "string" ? o.goal : "",
    summary: typeof o.summary === "string" ? o.summary : "",
    executed: o.executed === true,
    steps,
  };
}

const STATUS_META: Record<
  StepStatus,
  {
    Icon: React.ComponentType<{ className?: string }>;
    cls: string;
    label: string;
  }
> = {
  success: { Icon: CheckCircle2, cls: "text-success", label: "Success" },
  error: { Icon: XCircle, cls: "text-error", label: "Error" },
  skipped: {
    Icon: MinusCircle,
    cls: "text-muted-foreground",
    label: "Skipped",
  },
};

function StepRow({
  step,
  index,
}: {
  step: ChainStep;
  index: number;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const { Icon, cls, label } = STATUS_META[step.status];
  const hasDetail =
    step.input !== null || step.output !== undefined || Boolean(step.error);

  return (
    <li className="relative pl-6">
      {/* timeline rail */}
      <span
        className="absolute left-[7px] top-5 bottom-0 w-px bg-border"
        aria-hidden="true"
      />
      <Icon
        className={cn("absolute left-0 top-1 size-3.5", cls)}
        aria-label={label}
      />

      <div className="pb-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          disabled={!hasDetail}
          className="flex w-full items-center gap-2 text-left disabled:cursor-default"
        >
          {hasDetail ? (
            open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {index + 1}.
          </span>
          <span className="text-xs text-muted-foreground">
            {step.capability}
          </span>
          {step.durationMs > 0 ? (
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
              {step.durationMs}ms
            </span>
          ) : null}
        </button>

        {step.rationale ? (
          <p className="ml-6 mt-1 text-xs text-foreground/80">
            <TruncatedText text={step.rationale} lines={2} />
          </p>
        ) : null}

        {open && hasDetail ? (
          <div className="ml-6 mt-2 space-y-2">
            {step.input ? (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Input
                </div>
                <div className="mt-0.5 overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-2 text-[11px]">
                  <StructuredValue value={step.input} />
                </div>
              </div>
            ) : null}
            {step.output !== undefined ? (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Output
                </div>
                <div className="mt-0.5 max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-2 text-[11px]">
                  <StructuredValue value={step.output} />
                </div>
              </div>
            ) : null}
            {step.error ? (
              <p className="text-xs text-error">{step.error}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export default function CapabilityChainCard(
  props: CapabilityChainCardProps,
): React.ReactElement {
  const chain = readChain(props.output);
  const succeeded = chain.steps.filter((s) => s.status === "success").length;

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="capability-chain-card"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Workflow className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">Composed chain</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {chain.executed
            ? `${succeeded}/${chain.steps.length} ran`
            : "Plan only"}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        {chain.summary ? (
          <p className="text-sm text-foreground">{chain.summary}</p>
        ) : null}
        {chain.goal ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Goal:</span> {chain.goal}
          </p>
        ) : null}

        {chain.steps.length > 0 ? (
          <ol className="mt-1">
            {chain.steps.map((step, i) => (
              <StepRow key={step.id || i} step={step} index={i} />
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">
            No steps were planned.
          </p>
        )}
      </div>
    </div>
  );
}
