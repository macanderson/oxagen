"use client";
/**
 * trigger-now-dialog.tsx — fire an automation on demand with an optional JSON
 * payload, for testing. Shows the resulting execution id + status inline, and
 * surfaces the capability's error message inline (not a generic toast) per the
 * editor spec. Reused by the list table and the automation editor.
 */
import { useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export interface TriggerNowResult {
  ok: boolean;
  executionId?: string;
  status?: string;
  error?: string;
}

export interface TriggerNowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  automationName: string;
  /** Parse + fire. Receives the parsed payload (or undefined) and returns the outcome. */
  onTrigger: (
    payload: Record<string, unknown> | undefined,
  ) => Promise<TriggerNowResult>;
}

export function TriggerNowDialog({
  open,
  onOpenChange,
  automationName,
  onTrigger,
}: TriggerNowDialogProps) {
  const [payloadText, setPayloadText] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TriggerNowResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  function reset() {
    setPayloadText("");
    setResult(null);
    setParseError(null);
  }

  async function handleTrigger() {
    setParseError(null);
    let payload: Record<string, unknown> | undefined;
    const trimmed = payloadText.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setParseError("Payload must be a JSON object.");
          return;
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        setParseError("Payload is not valid JSON.");
        return;
      }
    }
    setPending(true);
    try {
      const outcome = await onTrigger(payload);
      setResult(outcome);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Trigger “{automationName}” now</DialogTitle>
          <DialogDescription>
            Fire this automation once, immediately. Optionally pass a JSON
            payload the playbook can read. This runs the playbook whether or not
            the trigger is enabled.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="trigger-payload">
            Payload (optional JSON object)
          </Label>
          <Textarea
            id="trigger-payload"
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            placeholder={'{ "reason": "manual test" }'}
            rows={5}
            className="font-mono text-xs"
            data-testid="trigger-payload"
          />
          {parseError && <p className="text-xs text-error">{parseError}</p>}
        </div>

        {result && (
          <div
            className={
              result.ok
                ? "rounded-md border border-success/25 bg-success/10 p-3 text-sm text-success"
                : "rounded-md border border-error/25 bg-error/10 p-3 text-sm text-error"
            }
            data-testid="trigger-result"
          >
            {result.ok ? (
              <span>
                Execution{" "}
                <span className="font-mono">{result.executionId}</span> started
                — {result.status}.
              </span>
            ) : (
              <span>{result.error}</span>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
            type="button"
          >
            Close
          </Button>
          <Button
            onClick={handleTrigger}
            disabled={pending}
            type="button"
            data-testid="confirm-trigger"
          >
            {pending ? "Triggering…" : "Trigger now"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
