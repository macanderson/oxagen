"use client";
/**
 * message-receipt.tsx — the muted per-message run receipt (chat_ux_v2):
 * `{model} · {effort} · {$cost}` under a completed assistant message, with a
 * tap/click toggle revealing duration and token counts. Data comes from
 * `messages.metadata.receipt`, persisted by the stream route from the same
 * numbers the live usage event carried.
 *
 * Renders ONLY when the unified session provider is mounted (flag on) — the
 * legacy surface stays byte-identical without it.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import type { MessageReceipt } from "./stream-event-types";
import { useChatSessionContext } from "./session/session-store";

/**
 * Humane label for a gateway model id: "anthropic/claude-sonnet-5" →
 * "Claude Sonnet 5". Deterministic prettifier — no catalog lookup, so
 * history renders labels even for models no longer in the catalog.
 */
export function modelLabelOf(modelId: string): string {
  const slug = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  return slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) =>
      /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

/** "$0.31" from credits (1 credit = 1¢), or null when billing wasn't wired. */
export function formatReceiptCost(
  creditsCharged: number | undefined,
): string | null {
  if (creditsCharged === undefined || Number.isNaN(creditsCharged)) return null;
  return `$${(creditsCharged / 100).toFixed(2)}`;
}

/** "4.2s" / "1m 05s" for the expanded duration detail. */
export function formatReceiptDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function MessageReceiptLine({
  receipt,
  className,
}: {
  receipt: MessageReceipt;
  className?: string;
}) {
  const session = useChatSessionContext();
  const [expanded, setExpanded] = React.useState(false);
  if (!session) return null;

  const summary = [
    modelLabelOf(receipt.model),
    receipt.effort
      ? `${receipt.effort.charAt(0).toUpperCase()}${receipt.effort.slice(1)} effort`
      : null,
    formatReceiptCost(receipt.usage.creditsCharged),
  ]
    .filter(Boolean)
    .join(" · ");

  const detail = [
    formatReceiptDuration(receipt.durationMs),
    receipt.usage.totalTokens > 0
      ? `${receipt.usage.totalTokens.toLocaleString()} tokens`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      data-testid="message-receipt"
      aria-expanded={expanded}
      aria-label={`Run receipt: ${summary}`}
      onClick={() => setExpanded((v) => !v)}
      className={cn(
        "self-start text-left text-[11px] leading-relaxed text-muted-foreground/80",
        "rounded hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {summary}
      {expanded && detail ? <span> · {detail}</span> : null}
    </button>
  );
}
