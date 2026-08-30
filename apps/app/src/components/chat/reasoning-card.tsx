"use client";

/**
 * ReasoningCard — auto-collapsing "Thinking" disclosure.
 *
 * Expands and streams live while the model is reasoning, then AUTO-COLLAPSES
 * to a one-line "Thought for Xs" summary the first time status flips to
 * "done". The user can re-open it at any time; subsequent clicks toggle freely.
 *
 * Design: reasoning is secondary to the answer — card chrome is deliberately
 * quieter than ToolCallCard (muted bg, thin solid left accent while thinking).
 */

import * as React from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { transition } from "@oxagen/ui/lib/motion";
import { StreamingText } from "./streaming-text";
import { formatDuration } from "./tool-call-card";

export interface ReasoningCardProps {
  text: string;
  status: "thinking" | "done";
  durationMs?: number;
  className?: string;
}

export function ReasoningCard({
  text,
  status,
  durationMs,
  className,
}: ReasoningCardProps) {
  const reducedMotion = useReducedMotion();

  // Track the previous status so we can fire the auto-collapse exactly once on
  // the thinking→done edge — before the user has ever interacted.
  const prevStatusRef = React.useRef<"thinking" | "done">(status);
  // Whether the user has manually toggled at least once.
  const userInteractedRef = React.useRef(false);

  // Start open when thinking, so the live text is immediately visible.
  const [open, setOpen] = React.useState(status === "thinking");

  React.useEffect(() => {
    if (prevStatusRef.current === "thinking" && status === "done") {
      // Auto-collapse only on the first thinking→done edge, and only if the
      // user hasn't manually touched the disclosure.
      if (!userInteractedRef.current) {
        setOpen(false);
      }
    }
    prevStatusRef.current = status;
  }, [status]);

  function handleToggle() {
    userInteractedRef.current = true;
    setOpen((v) => !v);
  }

  // Some providers (e.g. Anthropic adaptive thinking) emit reasoning boundaries
  // but redact the content — the model thinks, yet no plaintext is exposed.
  // In that case we still surface that reasoning happened (and how long it took)
  // as a compact pill, but there's nothing to expand.
  const hasText = text.trim().length > 0;

  const label =
    status === "thinking"
      ? "Thinking…"
      : durationMs != null
        ? `Thought for ${formatDuration(durationMs)}`
        : "Reasoning";

  // Pulsing opacity animation on the "Thinking…" label.
  // We separate the animate target from the transition to avoid the Variants
  // type narrowing fighting the union — framer-motion accepts `animate` as a
  // plain TargetAndTransition object directly on the component without needing
  // a named variants map.
  const pulseAnimate = reducedMotion
    ? { opacity: 1 }
    : {
        opacity: [1, 0.45, 1] as number[],
        transition: {
          duration: 1.6,
          ease: [0.45, 0, 0.55, 1] as [number, number, number, number],
          repeat: Infinity,
        },
      };

  return (
    <div
      className={cn(
        "relative rounded-xl border border-border/60 bg-muted/30 text-sm overflow-hidden my-1.5",
        className,
      )}
      data-component="reasoning-card"
      data-status={status}
    >
      {/* Solid left accent bar while thinking.
          Absolute-positioned so it doesn't affect layout. */}
      {status === "thinking" && (
        <div
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-0.5 bg-primary z-10"
        />
      )}
      {/* Header row. Only a toggle when there's reasoning text to reveal;
          otherwise it's a static "Thinking…/Thought for Xs" pill (redacted). */}
      <button
        type="button"
        onClick={hasText ? handleToggle : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 px-3 py-2 text-left",
          !hasText && "cursor-default",
        )}
        aria-expanded={hasText ? open : undefined}
        disabled={!hasText}
      >
        <Brain
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />

        {status === "thinking" ? (
          <motion.span
            className="text-xs text-muted-foreground"
            animate={pulseAnimate}
          >
            {label}
          </motion.span>
        ) : (
          <span className="text-xs text-muted-foreground">{label}</span>
        )}

        {hasText ? (
          <span className="ml-auto text-muted-foreground/60">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </span>
        ) : null}
      </button>

      {/* Body — animated height/opacity collapse. Only when there's text. */}
      <AnimatePresence initial={false}>
        {hasText && open && (
          <motion.div
            key="reasoning-body"
            initial={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={
              reducedMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }
            }
            exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={transition.base}
            style={{ overflow: "hidden" }}
          >
            <div className="border-t border-border/40 px-3 py-2.5 max-h-72 overflow-y-auto">
              {status === "thinking" ? (
                <StreamingText
                  text={text}
                  isStreaming
                  className="text-sm text-muted-foreground"
                />
              ) : (
                <p className="text-sm text-muted-foreground/90 italic whitespace-pre-wrap leading-relaxed">
                  {text}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
