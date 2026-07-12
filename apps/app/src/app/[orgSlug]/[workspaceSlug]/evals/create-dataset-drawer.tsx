"use client";

/**
 * create-dataset-drawer.tsx — "New dataset" affordance for Workspace → Evals.
 *
 * Two independent halves so the form can be unit-tested without mounting the
 * Drawer/Sheet portal machinery:
 *   - CreateDatasetForm — the mode toggle (Manual / From traces) + fields +
 *     submit. Calls eval.dataset.create or eval.dataset.from_traces depending
 *     on the selected mode.
 *   - CreateDatasetDrawer — the Phase-0 Drawer shell wrapping the form.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { Drawer } from "../_shared/components";
import { createDatasetAction, createTraceDatasetAction } from "./actions";

type Mode = "manual" | "traces";

const SINCE_HOURS_OPTIONS = [
  { value: "24", label: "Last 24 hours" },
  { value: "72", label: "Last 3 days" },
  { value: "168", label: "Last 7 days" },
];

export interface CreateDatasetFormProps {
  orgSlug: string;
  workspaceSlug: string;
  /** Called after a successful create — the caller closes the drawer / refreshes. */
  onCreated: () => void;
}

export function CreateDatasetForm({ orgSlug, workspaceSlug, onCreated }: CreateDatasetFormProps) {
  const router = useRouter();
  const { add: addToast } = useToast();

  const [mode, setMode] = React.useState<Mode>("manual");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [sinceHours, setSinceHours] = React.useState("168");
  const [limit, setLimit] = React.useState("50");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const result =
        mode === "manual"
          ? await createDatasetAction({
              orgSlug,
              workspaceSlug,
              name: trimmedName,
              description: description.trim() || undefined,
            })
          : await createTraceDatasetAction({
              orgSlug,
              workspaceSlug,
              name: trimmedName,
              description: description.trim() || undefined,
              sinceHours: Number(sinceHours),
              limit: Number(limit),
            });

      if (result.ok) {
        addToast({
          title: "Dataset created",
          description: trimmedName,
          type: "background",
        });
        setName("");
        setDescription("");
        router.refresh();
        onCreated();
      } else {
        setError(result.error);
        addToast({
          title: "Failed to create dataset",
          description: result.error,
          type: "background",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="Create dataset">
      <div className="flex flex-col gap-1.5">
        <Label id="create-dataset-mode-label">Source</Label>
        <SegmentedControl
          value={mode}
          onValueChange={(v) => setMode(v as Mode)}
          aria-labelledby="create-dataset-mode-label"
        >
          <SegmentedControlItem value="manual" disabled={submitting}>
            Manual
          </SegmentedControlItem>
          <SegmentedControlItem value="traces" disabled={submitting}>
            From traces
          </SegmentedControlItem>
        </SegmentedControl>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dataset-name">Name</Label>
        <Input
          id="dataset-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Support triage cases"
          disabled={submitting}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dataset-description">Description</Label>
        <Textarea
          id="dataset-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this dataset is for"
          disabled={submitting}
          rows={2}
        />
      </div>

      {mode === "traces" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label id="dataset-since-hours-label">Lookback window</Label>
            <Select value={sinceHours} onValueChange={(v) => v && setSinceHours(v)} disabled={submitting}>
              <SelectTrigger size="default" aria-labelledby="dataset-since-hours-label">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {SINCE_HOURS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dataset-limit">Max items</Label>
            <Input
              id="dataset-limit"
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              disabled={submitting}
            />
          </div>
        </>
      )}

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={submitting}
        data-testid={
          mode === "manual" ? "evals-create-manual-submit" : "evals-create-traces-submit"
        }
      >
        {submitting ? "Creating…" : mode === "manual" ? "Create dataset" : "Create from traces"}
      </Button>
    </form>
  );
}

export interface CreateDatasetDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgSlug: string;
  workspaceSlug: string;
}

export function CreateDatasetDrawer({
  open,
  onOpenChange,
  orgSlug,
  workspaceSlug,
}: CreateDatasetDrawerProps) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="New dataset"
      description="Create a dataset manually or seed it from real, already-metered traces."
    >
      <CreateDatasetForm
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        onCreated={() => onOpenChange(false)}
      />
    </Drawer>
  );
}
