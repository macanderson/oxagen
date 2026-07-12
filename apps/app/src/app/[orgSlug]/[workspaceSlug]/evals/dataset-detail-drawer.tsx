"use client";

/**
 * dataset-detail-drawer.tsx — dataset detail Drawer for Workspace → Evals.
 *
 * Opens on a dataset card click. Fetches the dataset + a page of its items
 * via eval.dataset.get on open, offers an "Add item" form (eval.dataset_item.add),
 * and a "Run eval" launcher (eval.run.start) that polls eval.run.status every
 * ~2s (capped at ~30s) once a run is started, then links to the run detail
 * page (workspace.evals.run).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { useToast } from "@/components/ui/toast";
import { Drawer } from "../_shared/components";
import { workspace } from "@/lib/routes";
import type { EvalDatasetGetOutput } from "@oxagen/oxagen/contracts/eval.dataset.get";
import type { EvalRunStatusOutput } from "@oxagen/oxagen/contracts/eval.run.status";
import {
  getDatasetAction,
  addDatasetItemAction,
  startEvalRunAction,
  getEvalRunStatusAction,
} from "./actions";

type Dataset = EvalDatasetGetOutput["dataset"];
type DatasetItem = EvalDatasetGetOutput["items"][number];
type TargetKind = "model" | "agent";

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15; // ~30s
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface DatasetDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
  /** Null while no dataset is selected — the Drawer stays closed in that case. */
  datasetPublicId: string | null;
}

export function DatasetDetailDrawer({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
  datasetPublicId,
}: DatasetDetailDrawerProps) {
  const router = useRouter();
  const { add: addToast } = useToast();

  const [loading, setLoading] = React.useState(false);
  const [dataset, setDataset] = React.useState<Dataset | null>(null);
  const [items, setItems] = React.useState<DatasetItem[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  // Add item form
  const [itemInput, setItemInput] = React.useState("");
  const [itemExpected, setItemExpected] = React.useState("");
  const [addingItem, setAddingItem] = React.useState(false);
  const [addItemError, setAddItemError] = React.useState<string | null>(null);

  // Run launcher
  const [targetKind, setTargetKind] = React.useState<TargetKind>("model");
  const [model, setModel] = React.useState("");
  const [agentSlug, setAgentSlug] = React.useState("");
  const [judgeModel, setJudgeModel] = React.useState("");
  const [runName, setRunName] = React.useState("");
  const [passThreshold, setPassThreshold] = React.useState("0.7");
  const [maxItems, setMaxItems] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [runStatus, setRunStatus] = React.useState<EvalRunStatusOutput | null>(null);
  const [polling, setPolling] = React.useState(false);

  const load = React.useCallback(
    async (cursor?: string) => {
      if (!datasetPublicId) return;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await getDatasetAction({
          orgSlug,
          workspaceSlug,
          datasetPublicId,
          cursor,
        });
        if (result.ok) {
          setDataset(result.dataset);
          setItems((prev) => (cursor ? [...prev, ...result.items] : result.items));
          setNextCursor(result.nextCursor);
        } else {
          setLoadError(result.error);
        }
      } finally {
        setLoading(false);
      }
    },
    [orgSlug, workspaceSlug, datasetPublicId],
  );

  // Reset local state and fetch fresh whenever a new dataset is opened.
  React.useEffect(() => {
    if (open && datasetPublicId) {
      setDataset(null);
      setItems([]);
      setNextCursor(null);
      setLoadError(null);
      setRunId(null);
      setRunStatus(null);
      setRunError(null);
      void load();
    }
  }, [open, datasetPublicId, load]);

  // Poll eval.run.status while a run is active — every 2s, capped at ~30s.
  React.useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      attempts += 1;
      const result = await getEvalRunStatusAction({ orgSlug, workspaceSlug, runPublicId: runId });
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

  const handleAddItem: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    const trimmedInput = itemInput.trim();
    if (!trimmedInput) {
      setAddItemError("Input is required.");
      return;
    }
    if (!datasetPublicId) return;

    setAddItemError(null);
    setAddingItem(true);
    try {
      const result = await addDatasetItemAction({
        orgSlug,
        workspaceSlug,
        datasetPublicId,
        input: trimmedInput,
        expectedOutput: itemExpected.trim() || undefined,
      });
      if (result.ok) {
        setItemInput("");
        setItemExpected("");
        addToast({ title: "Item added", type: "background" });
        await load();
        router.refresh();
      } else {
        setAddItemError(result.error);
        addToast({
          title: "Failed to add item",
          description: result.error,
          type: "background",
        });
      }
    } finally {
      setAddingItem(false);
    }
  };

  const handleStartRun: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    if (!datasetPublicId) return;

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
          ? { kind: "model" as const, ...(model.trim() ? { model: model.trim() } : {}) }
          : { kind: "agent" as const, agentSlug: agentSlug.trim() };

      const parsedThreshold = Number(passThreshold);
      const result = await startEvalRunAction({
        orgSlug,
        workspaceSlug,
        datasetPublicId,
        target,
        judgeModel: judgeModel.trim() || undefined,
        name: runName.trim() || undefined,
        passThreshold: Number.isFinite(parsedThreshold) ? parsedThreshold : 0.7,
        maxItems: maxItems.trim() ? Number(maxItems) : undefined,
      });

      if (result.ok) {
        setRunId(result.runId);
        addToast({
          title: "Eval run started",
          description: `${result.itemCount} item${result.itemCount === 1 ? "" : "s"} queued`,
          type: "background",
        });
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
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={dataset?.name ?? "Dataset"}
      description={dataset?.description ?? undefined}
    >
      <div className="flex flex-col gap-6" data-testid="evals-dataset-drawer">
        {loading && items.length === 0 && !dataset ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading dataset…
          </div>
        ) : loadError ? (
          <p className="text-sm text-destructive" role="alert">
            {loadError}
          </p>
        ) : (
          <>
            {/* Items */}
            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                Items ({dataset?.itemCount ?? items.length})
              </h3>
              {items.length === 0 ? (
                <p className="text-xs text-muted-foreground">No items yet — add one below.</p>
              ) : (
                <ul className="flex flex-col gap-2" data-testid="evals-dataset-items">
                  {items.map((item) => (
                    <li
                      key={item.itemId}
                      className="rounded-md border border-border/60 p-2.5 text-xs"
                      data-testid="evals-dataset-item"
                    >
                      <p className="line-clamp-2 text-foreground">{item.input}</p>
                      {item.expectedOutput && (
                        <p className="mt-1 line-clamp-2 text-muted-foreground">
                          Expected: {item.expectedOutput}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {nextCursor && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void load(nextCursor)}
                >
                  Load more
                </Button>
              )}

              <form
                onSubmit={handleAddItem}
                className="flex flex-col gap-2 border-t border-border/60 pt-3"
                aria-label="Add item"
              >
                <Label htmlFor="item-input">Input</Label>
                <Textarea
                  id="item-input"
                  value={itemInput}
                  onChange={(e) => setItemInput(e.target.value)}
                  rows={2}
                  disabled={addingItem}
                  placeholder="What is 2+2?"
                />
                <Label htmlFor="item-expected">Expected output (optional)</Label>
                <Textarea
                  id="item-expected"
                  value={itemExpected}
                  onChange={(e) => setItemExpected(e.target.value)}
                  rows={2}
                  disabled={addingItem}
                  placeholder="4"
                />
                {addItemError && (
                  <p className="text-xs text-destructive" role="alert">
                    {addItemError}
                  </p>
                )}
                <Button
                  type="submit"
                  size="sm"
                  disabled={addingItem}
                  data-testid="evals-add-item-submit"
                >
                  {addingItem ? "Adding…" : "Add item"}
                </Button>
              </form>
            </section>

            {/* Run launcher */}
            <section className="flex flex-col gap-3 border-t border-border/60 pt-4">
              <h3 className="text-sm font-semibold text-foreground">Run eval</h3>
              <form onSubmit={handleStartRun} className="flex flex-col gap-3" aria-label="Run eval">
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
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="run-model">Model (optional)</Label>
                    <Input
                      id="run-model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="Default tier"
                      disabled={starting}
                    />
                  </div>
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

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="run-name">Run name (optional)</Label>
                  <Input
                    id="run-name"
                    value={runName}
                    onChange={(e) => setRunName(e.target.value)}
                    disabled={starting}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="run-judge-model">Judge model (optional)</Label>
                  <Input
                    id="run-judge-model"
                    value={judgeModel}
                    onChange={(e) => setJudgeModel(e.target.value)}
                    placeholder="Default judge"
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

                <Button type="submit" disabled={starting} data-testid="evals-run-start">
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
                      {runStatus.failedCount > 0 ? `, ${runStatus.failedCount} failed` : ""}
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
          </>
        )}
      </div>
    </Drawer>
  );
}
