"use client";

/**
 * run-setup-panel.tsx — the eval-run launcher section on the dataset detail
 * page.
 *
 * The target and judge models are chosen with <ProviderModelPicker>
 * (provider→model dropdowns). The target model picker is only shown when the
 * target kind is "model"; the "agent" kind takes a free-text slug instead
 * (only MODELS use the dropdowns). On a successful launch it calls
 * `router.refresh()` (and the optional `onRunStarted` callback) so the seeded
 * runs table + score series re-fetch.
 *
 * Poll: eval.run.status every 2s, capped at ~30s, terminal = completed |
 * failed | cancelled.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useToast } from "@/components/ui/toast";
import { ProviderModelPicker } from "@/components/ai";
import { workspace } from "@/lib/routes";
import type { EvalRunStatusOutput } from "@oxagen/oxagen/contracts/eval.run.status";
import { startEvalRunAction, getEvalRunStatusAction } from "../../actions";

type TargetKind = "model" | "agent";

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15; // ~30s
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface RunSetupPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  datasetPublicId: string;
  /** Called after a run is successfully started (in addition to router.refresh). */
  onRunStarted?: () => void;
}

export function RunSetupPanel({
  orgSlug,
  workspaceSlug,
  datasetPublicId,
  onRunStarted,
}: RunSetupPanelProps) {
  const router = useRouter();
  const { add: addToast } = useToast();

  const [targetKind, setTargetKind] = React.useState<TargetKind>("model");
  // Provider→model picker state: null = "Default tier".
  const [model, setModel] = React.useState<string | null>(null);
  const [agentSlug, setAgentSlug] = React.useState("");
  const [judgeModel, setJudgeModel] = React.useState<string | null>(null);
  const [runName, setRunName] = React.useState("");
  const [passThreshold, setPassThreshold] = React.useState("0.7");
  const [maxItems, setMaxItems] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [runStatus, setRunStatus] = React.useState<EvalRunStatusOutput | null>(
    null,
  );
  const [polling, setPolling] = React.useState(false);

  // Poll eval.run.status while a run is active — every 2s, capped at ~30s.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      attempts += 1;
      const result = await getEvalRunStatusAction({
        orgSlug,
        workspaceSlug,
        runPublicId: runId,
      });
      if (cancelled) return;
      if (!result.ok) {
        setPolling(false);
        return;
      }
      setRunStatus(result.status);
      const terminal = TERMINAL_RUN_STATUSES.has(result.status.status);
      if (terminal || attempts >= POLL_MAX_ATTEMPTS) {
        setPolling(false);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    setPolling(true);
    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, orgSlug, workspaceSlug]);

  const handleStartRun: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();

    if (targetKind === "agent" && !agentSlug.trim()) {
      setRunError("Agent slug is required.");
      return;
    }

    setRunError(null);
    setStarting(true);
    setRunStatus(null);
    try {
      const target =
        targetKind === "model"
          ? { kind: "model" as const, ...(model ? { model } : {}) }
          : { kind: "agent" as const, agentSlug: agentSlug.trim() };

      // Number("") is 0, not NaN — so an emptied field would silently start the
      // run at threshold 0 (everything passes). Treat blank as "use the
      // default" alongside the unparseable case.
      const trimmedThreshold = passThreshold.trim();
      const parsedThreshold = trimmedThreshold ? Number(trimmedThreshold) : NaN;
      const result = await startEvalRunAction({
        orgSlug,
        workspaceSlug,
        datasetPublicId,
        target,
        judgeModel: judgeModel ?? undefined,
        name: runName.trim() || undefined,
        passThreshold: Number.isFinite(parsedThreshold) ? parsedThreshold : 0.7,
        maxItems: maxItems.trim() ? Number(maxItems) : undefined,
      });

      if (result.ok) {
        setRunId(result.runId);
        addToast({
          title: "Eval run started",
          description: `${result.itemCount} item${
            result.itemCount === 1 ? "" : "s"
          } queued`,
          type: "background",
        });
        // Re-run the RSC fetch so the seeded runs table + score series update.
        router.refresh();
        onRunStarted?.();
      } else {
        setRunError(result.error);
        addToast({
          title: "Failed to start eval run",
          description: result.error,
          type: "background",
        });
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-lg border border-border/60 p-4"
      data-testid="evals-run-setup"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-foreground">Run eval</h3>
        <p className="text-xs text-muted-foreground">
          Launch a run against this dataset. Pick a target and judge model, or
          keep the default tier.
        </p>
      </div>

      <form
        onSubmit={handleStartRun}
        className="flex flex-col gap-4"
        aria-label="Run eval"
      >
        <div className="flex flex-col gap-1.5">
          <Label id="run-target-kind-label">Target</Label>
          <SegmentedControl
            value={targetKind}
            onValueChange={(v) => setTargetKind(v as TargetKind)}
            aria-labelledby="run-target-kind-label"
          >
            <SegmentedControlItem value="model" disabled={starting}>
              Model
            </SegmentedControlItem>
            <SegmentedControlItem value="agent" disabled={starting}>
              Agent
            </SegmentedControlItem>
          </SegmentedControl>
        </div>

        {targetKind === "model" ? (
          <ProviderModelPicker
            value={model}
            onChange={setModel}
            includeDefaultOption
            idPrefix="target"
            providerLabel="Target provider"
            modelLabel="Target model"
            disabled={starting}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="run-agent-slug">Agent slug</Label>
            <Input
              id="run-agent-slug"
              value={agentSlug}
              onChange={(e) => setAgentSlug(e.target.value)}
              placeholder="support-bot"
              disabled={starting}
            />
          </div>
        )}

        <ProviderModelPicker
          value={judgeModel}
          onChange={setJudgeModel}
          includeDefaultOption
          idPrefix="judge"
          providerLabel="Judge provider"
          modelLabel="Judge model"
          disabled={starting}
        />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="run-name">Run name (optional)</Label>
          <Input
            id="run-name"
            value={runName}
            onChange={(e) => setRunName(e.target.value)}
            disabled={starting}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="run-pass-threshold">Pass threshold</Label>
            <Input
              id="run-pass-threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={passThreshold}
              onChange={(e) => setPassThreshold(e.target.value)}
              disabled={starting}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="run-max-items">Max items (optional)</Label>
            <Input
              id="run-max-items"
              type="number"
              min={1}
              max={500}
              value={maxItems}
              onChange={(e) => setMaxItems(e.target.value)}
              disabled={starting}
            />
          </div>
        </div>

        {runError && (
          <p className="text-xs text-destructive" role="alert">
            {runError}
          </p>
        )}

        <Button
          type="submit"
          disabled={starting}
          data-testid="evals-run-start"
          className="w-fit"
        >
          {starting ? "Starting…" : "Run eval"}
        </Button>
      </form>

      {runId && (
        <div
          className="flex flex-col gap-2 rounded-md border border-border/60 p-3 text-xs"
          data-testid="evals-run-status"
        >
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Run {runId}</span>
            <Badge variant="outline" size="sm" className="capitalize">
              {runStatus?.status ?? "pending"}
            </Badge>
          </div>
          {runStatus && (
            <p className="text-muted-foreground">
              {runStatus.completedCount}/{runStatus.itemCount} completed
              {runStatus.failedCount > 0
                ? `, ${runStatus.failedCount} failed`
                : ""}
              {runStatus.avgScore != null
                ? ` · avg score ${runStatus.avgScore.toFixed(2)}`
                : ""}
            </p>
          )}
          {polling && <p className="text-muted-foreground">Still running…</p>}
          <Link
            href={workspace.evals.run({ orgSlug, workspaceSlug }, runId)}
            className="text-primary underline-offset-2 hover:underline"
            data-testid="evals-view-run"
          >
            View results
          </Link>
        </div>
      )}
    </section>
  );
}
