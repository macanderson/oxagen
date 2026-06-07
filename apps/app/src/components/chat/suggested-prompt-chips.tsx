"use client";

/**
 * SuggestedPromptChips — renders exactly 3 context-aware prompt chips above
 * the composer (and/or in the empty-state area).
 *
 * Each chip auto-submits its prompt through the existing ComposerAction send
 * path (no second transport). Chips are keyboard-navigable (role="button",
 * tabIndex, Enter/Space to activate).
 *
 * The chip list is derived from `useSuggestedPrompts()` which is always
 * length-3 and updates reactively as the page context changes.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { useSuggestedPrompts } from "@/lib/page-context/suggested-prompts";
import type { ComposerAction } from "./message-composer";

export interface SuggestedPromptChipsProps {
  /**
   * The same ComposerAction bound to the MessageComposer. When a chip is
   * clicked the prompt is submitted through this action, so the send flow is
   * identical to typing and clicking Send.
   */
  action: ComposerAction;

  /**
   * The current conversationId — forwarded to the FormData payload so the
   * message lands in the right conversation thread.
   */
  conversationId: string | null;

  /**
   * The active leaf message id — forwarded so the chip message parents off the
   * correct DB node.
   */
  parentMessageId: string | null;

  /**
   * Additional className applied to the outer <div> container.
   */
  className?: string;
}

/**
 * Build a FormData payload that mirrors what MessageComposer sends when the
 * user types a message and clicks Send. This is the minimum viable payload;
 * the composer resolves tier/model defaults server-side when absent.
 */
export function buildChipFormData(
  prompt: string,
  conversationId: string | null,
  parentMessageId: string | null,
): FormData {
  const fd = new FormData();
  fd.set("content", prompt);
  if (conversationId) fd.set("conversationId", conversationId);
  if (parentMessageId) fd.set("parentMessageId", parentMessageId);
  return fd;
}

export function SuggestedPromptChips({
  action,
  conversationId,
  parentMessageId,
  className,
}: SuggestedPromptChipsProps) {
  const prompts = useSuggestedPrompts();
  const [pending, startTransition] = React.useTransition();
  const [activatingIndex, setActivatingIndex] = React.useState<number | null>(null);

  const handleActivate = React.useCallback(
    (prompt: string, index: number) => {
      if (pending) return;
      setActivatingIndex(index);
      const fd = buildChipFormData(prompt, conversationId, parentMessageId);
      startTransition(async () => {
        await action(fd);
        setActivatingIndex(null);
      });
    },
    [action, conversationId, parentMessageId, pending],
  );

  // Keyboard handler: activate on Enter or Space.
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, prompt: string, index: number) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleActivate(prompt, index);
      }
    },
    [handleActivate],
  );

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      role="group"
      aria-label="Suggested prompts"
    >
      {prompts.map(({ label, prompt }, index) => (
        <button
          key={`${index}-${label}`}
          type="button"
          role="button"
          tabIndex={0}
          disabled={pending}
          onClick={() => handleActivate(prompt, index)}
          onKeyDown={(e) => handleKeyDown(e, prompt, index)}
          title={prompt}
          aria-label={`Suggested prompt: ${label}`}
          aria-busy={activatingIndex === index}
          className={cn(
            // Base chip style
            "inline-flex items-center rounded-full border border-border",
            "bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground",
            "transition-all hover:bg-muted hover:border-border/80 hover:shadow-sm",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "active:scale-95",
            // Activating state
            activatingIndex === index && "opacity-60 pointer-events-none",
            // Disabled while any chip is activating
            pending && activatingIndex !== index && "opacity-40 pointer-events-none",
          )}
        >
          {activatingIndex === index ? (
            // Minimal in-flight indicator — a single spinning dot replacing the label.
            <span
              className="inline-block size-3 animate-spin rounded-full border border-current border-t-transparent"
              aria-hidden="true"
            />
          ) : (
            <span className="truncate max-w-[200px]">{label}</span>
          )}
        </button>
      ))}
    </div>
  );
}
