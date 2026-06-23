"use client";
import * as React from "react";
import { Check, Copy, BrainCircuit, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

/**
 * Footer rendered below every assistant message. Surfaces:
 *  • the small action-button row — Copy, Save as Knowledge, Save as Memory
 *  • per-turn credit cost + token count (when the turn produced usage)
 *
 * Save handlers run user-provided async callbacks; the icon flips to a check
 * for ~2s on success and the toast (also user-provided) communicates the
 * outcome. The component is presentation only — it does not call server
 * actions directly so it stays trivially testable.
 *
 * `creditsCharged` and `totalTokens` come from the SSE `usage` event (live)
 * or the persisted assistant message metadata (after refresh). Either may be
 * undefined; we render nothing when both are missing OR when the turn produced
 * zero tokens (e.g. a stream error before the model was called).
 */
export interface MessageFooterProps {
  text: string;
  /** Credits priced from the canonical pricing.ts rates. Optional. */
  creditsCharged?: number;
  /** Total tokens consumed this turn. Optional. */
  totalTokens?: number;
  /** Save-as-Knowledge handler. Awaited, with a success/failure result. */
  onSaveKnowledge?: (text: string) => Promise<{ ok: boolean; error?: string }>;
  /** Save-as-Memory handler. Awaited, with a success/failure result. */
  onSaveMemory?: (text: string) => Promise<{ ok: boolean; error?: string }>;
  className?: string;
}

type SaveState = "idle" | "pending" | "saved";

export function MessageFooter({
  text,
  creditsCharged,
  totalTokens,
  onSaveKnowledge,
  onSaveMemory,
  className,
}: MessageFooterProps) {
  const trimmedText = text.trim();
  const canCopy = trimmedText.length > 0;
  const [copied, setCopied] = React.useState(false);
  const [savedKnowledge, setSavedKnowledge] = React.useState<SaveState>("idle");
  const [savedMemory, setSavedMemory] = React.useState<SaveState>("idle");
  const toast = useToast();

  const handleCopy = React.useCallback(async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.add({
        title: "Failed to copy",
        description: "Could not copy the message to clipboard.",
        type: "error",
      });
    }
  }, [canCopy, text, toast]);

  const handleSave = React.useCallback(
    async (
      handler: ((text: string) => Promise<{ ok: boolean; error?: string }>) | undefined,
      setState: (s: SaveState) => void,
      labels: { success: string; failure: string; description: string },
    ) => {
      if (!canCopy || !handler) return;
      setState("pending");
      try {
        const result = await handler(text);
        if (result.ok) {
          setState("saved");
          toast.add({
            title: labels.success,
            description: labels.description,
            type: "success",
          });
          window.setTimeout(() => setState("idle"), 2500);
        } else {
          setState("idle");
          toast.add({
            title: labels.failure,
            description: result.error ?? "Try again.",
            type: "error",
          });
        }
      } catch (err) {
        setState("idle");
        toast.add({
          title: labels.failure,
          description: err instanceof Error ? err.message : "Try again.",
          type: "error",
        });
      }
    },
    [canCopy, text, toast],
  );

  const showUsage =
    (creditsCharged !== undefined && creditsCharged > 0) ||
    (totalTokens !== undefined && totalTokens > 0);

  return (
    <div
      className={cn(
        "mt-2 flex items-center gap-2 text-xs text-muted-foreground",
        className,
      )}
      data-component="message-footer"
    >
      <div className="flex items-center gap-1" data-action-row>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!canCopy}
          aria-label={copied ? "Copied" : "Copy message"}
          title={copied ? "Copied" : "Copy"}
          className={cn(
            "rounded p-1 transition-colors hover:bg-muted disabled:opacity-50",
            copied && "text-success",
          )}
          data-testid="message-footer-copy"
          data-state={copied ? "saved" : "idle"}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>

        {onSaveKnowledge ? (
          <button
            type="button"
            disabled={!canCopy || savedKnowledge === "pending"}
            onClick={() =>
              handleSave(onSaveKnowledge, setSavedKnowledge, {
                success: "Saved to knowledge graph",
                failure: "Failed to save as knowledge",
                description: "Entities were extracted and embedded into the workspace ontology.",
              })
            }
            aria-label={savedKnowledge === "saved" ? "Saved to knowledge" : "Save to knowledge graph"}
            title={savedKnowledge === "saved" ? "Saved to knowledge" : "Save to knowledge graph"}
            className={cn(
              "rounded p-1 transition-colors hover:bg-muted disabled:opacity-50",
              savedKnowledge === "saved" && "text-success",
            )}
            data-testid="message-footer-save-knowledge"
            data-state={savedKnowledge}
          >
            {savedKnowledge === "saved" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Network className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}

        {onSaveMemory ? (
          <button
            type="button"
            disabled={!canCopy || savedMemory === "pending"}
            onClick={() =>
              handleSave(onSaveMemory, setSavedMemory, {
                success: "Saved as memory",
                failure: "Failed to save as memory",
                description: "A Memory node was added to the workspace knowledge graph.",
              })
            }
            aria-label={savedMemory === "saved" ? "Saved as memory" : "Save as memory"}
            title={savedMemory === "saved" ? "Saved as memory" : "Save as memory"}
            className={cn(
              "rounded p-1 transition-colors hover:bg-muted disabled:opacity-50",
              savedMemory === "saved" && "text-success",
            )}
            data-testid="message-footer-save-memory"
            data-state={savedMemory}
          >
            {savedMemory === "saved" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <BrainCircuit className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
      </div>

      {showUsage ? (
        <span className="ml-auto tabular-nums" data-testid="message-footer-usage">
          {creditsCharged !== undefined && creditsCharged > 0 ? (
            <>
              {creditsCharged.toLocaleString()} credit{creditsCharged === 1 ? "" : "s"}
            </>
          ) : null}
          {creditsCharged !== undefined && creditsCharged > 0 && totalTokens !== undefined && totalTokens > 0
            ? " · "
            : null}
          {totalTokens !== undefined && totalTokens > 0
            ? `${totalTokens.toLocaleString()} tokens`
            : null}
        </span>
      ) : null}
    </div>
  );
}
