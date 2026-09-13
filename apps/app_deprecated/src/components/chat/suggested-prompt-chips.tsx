"use client";

/**
 * SuggestedPromptChips — renders a short row of context-aware prompt chips
 * above the composer (and/or in the empty-state area).
 *
 * Each chip auto-submits its prompt through the existing ComposerAction send
 * path (no second transport). Every chip is a real `<button>`, so Enter/Space
 * and focus order come from the browser.
 *
 * Two sources feed the row. The `suggestions` prop — this turn's LLM-generated
 * chips — wins whenever it is non-empty. Otherwise the row falls back to
 * `useSuggestedPrompts()`, which returns 3 chips derived from the page context
 * and updates reactively as that context changes. `maxPrompts` caps whichever
 * source is in play.
 */

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSuggestedPrompts } from "@/lib/page-context/suggested-prompts";
import { toSentenceCase } from "@/lib/to-sentence-case";
import type { ConversationMessageSummary } from "@/lib/page-context/suggested-prompts";
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
   * When true, the chips are hidden because the user is actively typing in
   * the composer input. Chips reappear when the input is cleared (false).
   * Defaults to false (chips visible).
   */
  inputHasContent?: boolean;

  /**
   * Recent conversation messages forwarded to `useSuggestedPrompts` so
   * suggestions stay contextually relevant across multi-turn conversations.
   */
  conversationHistory?: ConversationMessageSummary[];

  /**
   * Per-turn, LLM-generated suggestions from the stream's "suggested-prompts"
   * event. When provided and non-empty these REPLACE the static
   * `useSuggestedPrompts()` heuristics — they are conversation-aware and change
   * every turn. Null/empty (generation failed, timed out, or empty state) falls
   * back to the static heuristics so chips are always present.
   */
  suggestions?: ReadonlyArray<{ label: string; prompt: string }> | null;

  /**
   * Additional className applied to the outer <div> container.
   */
  className?: string;
  /** chat_ux_v2 copy pass: render chip labels in sentence case. */
  sentenceCase?: boolean;
  /** Cap the number of rendered chips (v2 empty state shows at most 3). */
  maxPrompts?: number;
  /** v2 mobile empty state: full-width, vertically stacked chips. */
  stacked?: boolean;
  /** Horizontal alignment of the chip row (v2 desktop docks left). */
  align?: "center" | "start";
  /**
   * Render each chip with a trailing "×" that dismisses the whole suggestion
   * group for the current turn. Used for the single post-first-message
   * next-step pill — the user can wave it away, and it returns (undismissed)
   * only when a fresh suggestion arrives on the next turn.
   */
  dismissable?: boolean;
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
  inputHasContent = false,
  conversationHistory,
  suggestions,
  sentenceCase = false,
  maxPrompts,
  stacked = false,
  align = "center",
  dismissable = false,
  className,
}: SuggestedPromptChipsProps) {
  // Always call the hook (Rules of Hooks) — it's the fallback source. When the
  // per-turn LLM suggestions are present they take precedence.
  const fallbackPrompts = useSuggestedPrompts(conversationHistory);
  const sourcePrompts =
    suggestions && suggestions.length > 0 ? suggestions : fallbackPrompts;
  // chat_ux_v2 copy pass: chips are sentence case, capped at 3.
  const prompts = React.useMemo(() => {
    const capped =
      maxPrompts !== undefined
        ? sourcePrompts.slice(0, maxPrompts)
        : sourcePrompts;
    if (!sentenceCase) return capped;
    return capped.map((p) => ({ ...p, label: toSentenceCase(p.label) }));
  }, [sourcePrompts, maxPrompts, sentenceCase]);

  // Re-trigger the entrance animation whenever the trio changes (each new turn
  // emits a fresh set), so the chips gently fade/slide in rather than snapping.
  const animationKey = prompts.map((p) => p.label).join("|");
  const [pending, startTransition] = React.useTransition();
  const [activatingIndex, setActivatingIndex] = React.useState<number | null>(
    null,
  );
  const [chipError, setChipError] = React.useState<string | null>(null);
  // Per-suggestion dismissal (only meaningful when `dismissable`): the user can
  // wave away the current next-step pill; it returns undismissed the moment a
  // fresh suggestion arrives (animationKey changes ⇒ this resets to false).
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => {
    setDismissed(false);
  }, [animationKey]);

  const handleActivate = React.useCallback(
    (prompt: string, index: number) => {
      if (pending) return;
      setActivatingIndex(index);
      setChipError(null);
      const fd = buildChipFormData(prompt, conversationId, parentMessageId);
      startTransition(async () => {
        const result = await action(fd);
        if (!result.ok) {
          // Surface the error so the user knows the message was not sent,
          // rather than leaving the chip silently de-activating.
          setChipError(result.error ?? "Failed to send message");
        }
        setActivatingIndex(null);
      });
    },
    [action, conversationId, parentMessageId, pending],
  );

  // Keyboard handler: activate on Enter or Space.
  const handleKeyDown = React.useCallback(
    (
      e: React.KeyboardEvent<HTMLButtonElement>,
      prompt: string,
      index: number,
    ) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleActivate(prompt, index);
      }
    },
    [handleActivate],
  );

  // Hide the entire chip group while the user is typing, and bring it back when
  // the input is cleared. The group is unmounted rather than hidden, so the row
  // gives its space back to the composer instead of leaving a blank gap.
  if (inputHasContent) return null;
  // Dismissed for this turn — stays hidden until the next suggestion arrives.
  if (dismissable && dismissed) return null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {chipError ? (
        <p
          role="alert"
          data-testid="chip-error"
          className="text-xs text-destructive text-center"
        >
          {chipError}
        </p>
      ) : null}
      <div
        key={animationKey}
        className={cn(
          "gap-2 animate-in fade-in slide-in-from-bottom-1 duration-300",
          stacked
            ? "flex w-full flex-col items-stretch"
            : align === "start"
              ? "flex flex-wrap items-center justify-start"
              : "flex flex-wrap items-center justify-center",
        )}
        role="group"
        aria-label="Suggested prompts"
      >
        {prompts.map(({ label, prompt }, index) => {
          const labelContent =
            activatingIndex === index ? (
              // Minimal in-flight indicator — a single spinning dot replacing the label.
              <span
                className="inline-block size-3 animate-spin rounded-full border border-current border-t-transparent"
                aria-hidden="true"
              />
            ) : (
              <span className="truncate max-w-[220px]">{label}</span>
            );

          if (dismissable) {
            // Pill-with-dismiss: the wrapper is styled as the chip so the label
            // button and the "×" read as a single pill, but they stay SEPARATE
            // buttons — a dismiss button nested inside the submit button would be
            // invalid (interactive-inside-interactive) HTML.
            return (
              <div
                key={`${index}-${label}`}
                className={cn(
                  "inline-flex items-center gap-0.5 rounded-full border border-border bg-muted/60 pl-3 pr-1 text-xs font-medium text-foreground",
                  "transition-all hover:border-border/80 hover:shadow-sm",
                  stacked && "min-h-11 w-full rounded-xl text-sm",
                  pending &&
                    activatingIndex !== index &&
                    "pointer-events-none opacity-40",
                )}
              >
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => handleActivate(prompt, index)}
                  onKeyDown={(e) => handleKeyDown(e, prompt, index)}
                  title={prompt}
                  aria-label={`Suggested prompt: ${label}`}
                  aria-busy={activatingIndex === index}
                  className={cn(
                    "flex min-w-0 flex-1 items-center rounded-full py-1.5 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "active:scale-[0.98]",
                    activatingIndex === index &&
                      "pointer-events-none opacity-60",
                  )}
                >
                  {labelContent}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setDismissed(true)}
                  aria-label="Dismiss suggestion"
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground",
                    "hover:bg-background/70 hover:text-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            );
          }

          return (
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
                // v2 mobile empty state: thumb-friendly full-width rows.
                stacked && "min-h-11 w-full justify-center rounded-xl text-sm",
                // Activating state
                activatingIndex === index && "opacity-60 pointer-events-none",
                // Disabled while any chip is activating
                pending &&
                  activatingIndex !== index &&
                  "opacity-40 pointer-events-none",
              )}
            >
              {labelContent}
            </button>
          );
        })}
      </div>
    </div>
  );
}
