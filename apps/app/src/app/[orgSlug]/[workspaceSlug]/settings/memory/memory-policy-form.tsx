"use client";

import { useState, useTransition } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveMemoryPolicyAction, type SaveMemoryPolicyResult } from "./actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  orgSlug: string;
  workspaceSlug: string;
  initialHalfLifeLow: number;
  initialHalfLifeHigh: number;
  initialRecallThreshold: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MemoryPolicyForm({
  orgSlug,
  workspaceSlug,
  initialHalfLifeLow,
  initialHalfLifeHigh,
  initialRecallThreshold,
}: Props) {
  const [halfLifeLow, setHalfLifeLow] = useState(initialHalfLifeLow);
  const [halfLifeHigh, setHalfLifeHigh] = useState(initialHalfLifeHigh);
  const [recallThreshold, setRecallThreshold] = useState(initialRecallThreshold);
  const [result, setResult] = useState<SaveMemoryPolicyResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveMemoryPolicyAction({
        orgSlug,
        workspaceSlug,
        halfLifeLowDays: halfLifeLow,
        halfLifeHighDays: halfLifeHigh,
        recallThreshold,
      });
      setResult(res);
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">Memory Policy</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure how agent memories decay over time and the confidence threshold for
          recall. Critical-weight memories never decay regardless of these settings.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        aria-label="Workspace memory policy settings"
        className="flex flex-col gap-6"
        noValidate
      >
        {/* Low-weight half-life */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="half-life-low"
            className="text-sm font-medium leading-none text-foreground"
          >
            Low-weight memory half-life (days)
          </label>
          <p className="text-xs text-muted-foreground">
            Days until a low-weight memory&rsquo;s confidence drops to 50%. Default: 30.
          </p>
          <Input
            id="half-life-low"
            name="halfLifeLowDays"
            type="number"
            min={1}
            max={3650}
            className="w-40"
            value={halfLifeLow}
            onChange={(e) => {
              setHalfLifeLow(Number(e.target.value));
              setResult(null);
            }}
          />
        </div>

        {/* High-weight half-life */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="half-life-high"
            className="text-sm font-medium leading-none text-foreground"
          >
            High-weight memory half-life (days)
          </label>
          <p className="text-xs text-muted-foreground">
            Days until a high-weight memory&rsquo;s confidence drops to 50%. Default: 90.
          </p>
          <Input
            id="half-life-high"
            name="halfLifeHighDays"
            type="number"
            min={1}
            max={3650}
            className="w-40"
            value={halfLifeHigh}
            onChange={(e) => {
              setHalfLifeHigh(Number(e.target.value));
              setResult(null);
            }}
          />
        </div>

        {/* Recall confidence threshold */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="recall-threshold"
            className="text-sm font-medium leading-none text-foreground"
          >
            Recall confidence threshold
          </label>
          <p className="text-xs text-muted-foreground">
            Memories below this confidence [0–1] are excluded from recall results.
            Default: 0.1.
          </p>
          <Input
            id="recall-threshold"
            name="recallThreshold"
            type="number"
            min={0}
            max={1}
            step={0.01}
            className="w-40"
            value={recallThreshold}
            onChange={(e) => {
              setRecallThreshold(Number(e.target.value));
              setResult(null);
            }}
          />
        </div>

        {/* Feedback */}
        {result && !result.ok && (
          <p className="text-sm text-destructive">{result.error}</p>
        )}
        {result?.ok && (
          <p className="text-sm text-green-600">Memory policy saved.</p>
        )}

        {/* Footer */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            variant="gradient"
            size="sm"
            disabled={isPending}
            startIcon={<Save className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {isPending ? "Saving…" : "Save policy"}
          </Button>
        </div>
      </form>
    </div>
  );
}
