"use client";
/**
 * PromptCacheBar — a compact, color-coded token-layer meter for a single turn.
 *
 * Inspired by the prompt-cache breakdowns you see in inference research: the
 * prompt for a turn is split into the fraction served from the provider's
 * prompt cache (a cache HIT — cheap, discounted) vs. the fresh input the model
 * had to re-read, plus the generated output. Rendering this every turn lets the
 * user instrument their cache-hit rate and spot *cache drift* — a turn where the
 * hit rate collapses means the prompt prefix changed and every following turn
 * will pay full price until it stabilizes.
 *
 * Design constraints (per the conversation-page usability spec):
 *   - NEUTRAL styling. The three layers are monochrome opacity tiers of the
 *     foreground, NOT red/green — colour is reserved for real error/success.
 *   - Descriptive, never dominant: a thin 4px bar + a muted caption line.
 *   - Accessible: role="img" with a full-sentence aria-label; the visual
 *     segments are aria-hidden; a hover tooltip repeats the exact counts.
 *   - Respects prefers-reduced-motion: the width transition is disabled there
 *     via the global reduce rule (transitions collapse to ~0ms).
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";

export interface PromptCacheBarProps {
  /** Prompt tokens for the turn (fresh + cached). */
  promptTokens: number;
  /** Generated (completion) tokens for the turn. */
  completionTokens: number;
  /** Prompt tokens served from the prompt cache (subset of promptTokens). */
  cachedTokens: number;
  className?: string;
}

/** Round to one decimal only when it isn't a whole number, so "100%" and
 * "42.7%" both read cleanly. */
function formatPct(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

/**
 * The three token layers, widest-to-narrowest semantic weight. Each is a
 * monochrome tier so the bar reads as "how much of this turn was cheap cache".
 */
interface Layer {
  key: "cached" | "fresh" | "output";
  label: string;
  tokens: number;
  /** Tailwind bg utility — opacity tiers of foreground (neutral, calm). */
  bg: string;
}

export function PromptCacheBar({
  promptTokens,
  completionTokens,
  cachedTokens,
  className,
}: PromptCacheBarProps) {
  // Clamp: cached can never exceed the prompt; all counts are non-negative.
  const prompt = Math.max(0, promptTokens);
  const output = Math.max(0, completionTokens);
  const cached = Math.max(0, Math.min(cachedTokens, prompt));
  const fresh = prompt - cached;
  const total = prompt + output;

  // Nothing to show — render nothing rather than an empty bar.
  if (total === 0) return null;

  // Cache-hit rate is over the PROMPT only (output is never cacheable input).
  const hitRate = prompt > 0 ? (cached / prompt) * 100 : 0;

  const layers: Layer[] = [
    { key: "cached", label: "Cached", tokens: cached, bg: "bg-foreground/70" },
    {
      key: "fresh",
      label: "Fresh input",
      tokens: fresh,
      bg: "bg-foreground/35",
    },
    { key: "output", label: "Output", tokens: output, bg: "bg-foreground/15" },
  ];

  const ariaLabel =
    `Prompt cache: ${formatPct(hitRate)} hit rate — ` +
    `${cached.toLocaleString()} cached, ${fresh.toLocaleString()} fresh input, ` +
    `${output.toLocaleString()} output tokens.`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn("flex items-center gap-1.5", className)}
            data-testid="prompt-cache-bar"
            data-hit-rate={hitRate.toFixed(1)}
            role="img"
            aria-label={ariaLabel}
          />
        }
      >
        {/* Layered bar */}
        <div
          className="flex h-1 w-16 overflow-hidden rounded-full bg-muted"
          aria-hidden="true"
        >
          {layers.map((layer) => {
            const pct = total > 0 ? (layer.tokens / total) * 100 : 0;
            if (pct === 0) return null;
            return (
              <div
                key={layer.key}
                data-layer={layer.key}
                className={cn(
                  "h-full transition-[width] duration-300",
                  layer.bg,
                )}
                style={{ width: `${pct}%` }}
              />
            );
          })}
        </div>
        {/* Headline: cache-hit rate. Muted, tabular so it doesn't jitter. */}
        <span
          className="text-xs tabular-nums text-muted-foreground"
          aria-hidden="true"
        >
          {formatPct(hitRate)} cached
        </span>
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="font-medium">
            Prompt cache · {formatPct(hitRate)} hit rate
          </span>
          {layers.map((layer) => (
            <span
              key={layer.key}
              className="tabular-nums text-muted-foreground"
            >
              {layer.label}: {layer.tokens.toLocaleString()}
            </span>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
