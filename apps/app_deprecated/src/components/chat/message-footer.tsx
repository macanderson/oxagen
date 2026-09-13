"use client";
/**
 * MessageFooter — rendered below every assistant message (live turn + persisted).
 *
 * Shows a token / credit summary and two action buttons:
 *   Copy          — write the assistant's text to the clipboard
 *   Save as Memory    — agent.memory.write via a scoped server action
 *
 * Each button flips to a check icon on success and resets after 2 seconds.
 * Toast feedback is shown on errors so the user isn't left wondering.
 */

import * as React from "react";
import { useState, useCallback } from "react";
import { Copy, Check, Brain } from "lucide-react";
import { useCopyToClipboard } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import type { TurnUsage } from "./stream-event-types";
import { saveAsMemoryAction } from "./message-footer-actions";
import { PromptCacheBar } from "./prompt-cache-bar";

export interface MessageFooterProps {
  /** The full plain text of the assistant message (for clipboard + save actions). */
  text: string;
  /** Token / credit usage summary. Rendered only when present. */
  usage?: TurnUsage;
  /** Slug context for server actions (scoped per org + workspace). */
  orgSlug: string;
  workspaceSlug: string;
}

type ButtonId = "copy" | "memory";

/**
 * A small icon-button that flips to a check on success.
 */
function ActionButton({
  id,
  label,
  icon,
  successIcon,
  done,
  loading,
  onClick,
}: {
  id: ButtonId;
  label: string;
  icon: React.ReactNode;
  successIcon?: React.ReactNode;
  done: boolean;
  loading: boolean;
  onClick: (id: ButtonId) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={loading}
            onClick={() => onClick(id)}
            aria-label={done ? `${label} — done` : label}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          />
        }
      >
        {done
          ? (successIcon ?? (
              <Check className="size-3.5 text-foreground" aria-hidden="true" />
            ))
          : icon}
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{done ? `${label} — done` : label}</TooltipPopup>
    </Tooltip>
  );
}

export function MessageFooter({
  text,
  usage,
  orgSlug,
  workspaceSlug,
}: MessageFooterProps) {
  const { add: addToast } = useToast();
  const { copy } = useCopyToClipboard();
  const [done, setDone] = useState<Set<ButtonId>>(new Set());
  const [loading, setLoading] = useState<ButtonId | null>(null);

  const markDone = useCallback((id: ButtonId) => {
    setDone((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setDone((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 2000);
  }, []);

  const handleClick = useCallback(
    async (id: ButtonId) => {
      if (loading) return;
      setLoading(id);
      try {
        if (id === "copy") {
          // useCopyToClipboard's own `copied` flag is unused here — this
          // footer's `done`/markDone Set already generalizes the "flip to a
          // check icon" behavior across copy/memory, so `copy` is
          // used only for its shared, guarded clipboard write. A `false`
          // return (write failed) falls through to the catch below via the
          // thrown error, preserving the existing "Action failed" toast.
          if (!(await copy(text))) throw new Error("clipboard write failed");
          markDone("copy");
        } else if (id === "memory") {
          const result = await saveAsMemoryAction(
            { orgSlug, workspaceSlug },
            text,
          );
          if (result.ok) {
            markDone("memory");
          } else {
            addToast({
              title: "Could not save memory",
              description: result.error,
              type: "error",
            });
          }
        }
      } catch {
        addToast({
          title: "Action failed",
          description: "Please try again.",
          type: "error",
        });
      } finally {
        setLoading(null);
      }
    },
    [loading, text, orgSlug, workspaceSlug, addToast, markDone, copy],
  );

  return (
    <div className="mt-2 flex items-center justify-between gap-2">
      {/* Token / credit summary + prompt-cache meter */}
      {usage !== undefined ? (
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {usage.totalTokens.toLocaleString()} tokens
            {usage.creditsCharged !== undefined
              ? ` · ${usage.creditsCharged} credit${usage.creditsCharged === 1 ? "" : "s"}`
              : null}
          </span>
          {usage.cachedTokens !== undefined && usage.cachedTokens > 0 ? (
            <PromptCacheBar
              promptTokens={usage.promptTokens}
              completionTokens={usage.completionTokens}
              cachedTokens={usage.cachedTokens}
            />
          ) : null}
        </div>
      ) : (
        <span aria-hidden="true" />
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-0.5">
        <ActionButton
          id="copy"
          label="Copy message"
          icon={<Copy className="size-3.5" aria-hidden="true" />}
          done={done.has("copy")}
          loading={loading === "copy"}
          onClick={handleClick}
        />
        <ActionButton
          id="memory"
          label="Save as Memory"
          icon={<Brain className="size-3.5" aria-hidden="true" />}
          done={done.has("memory")}
          loading={loading === "memory"}
          onClick={handleClick}
        />
      </div>
    </div>
  );
}
