/**
 * copyable-id.tsx — a compact, monospace identifier chip with copy-to-clipboard.
 *
 * The graph surfaces human labels, never raw ids — but ids must still be
 * copyable for support, deep-linking, and API calls. This renders a truncated,
 * tooltip-titled id with a one-click copy affordance that confirms with a brief
 * check state.
 */

"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useCopyToClipboard } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { truncate, truncateMiddle } from "./lib/format";

export interface CopyableIdProps {
  /** Full identifier (copied verbatim). */
  value: string;
  /** Optional leading label, e.g. "ID". */
  label?: string;
  /** Max visible characters before truncation. */
  max?: number;
  /**
   * Where the ellipsis lands. `end` (default) suits opaque ids. `middle`
   * suits dotted identifiers/keys (e.g. `oxagen.default.qa-chat`) where the
   * distinguishing tail must survive so a clip never reads as a typo.
   */
  ellipsis?: "end" | "middle";
  className?: string;
}

export function CopyableId({
  value,
  label,
  max = 16,
  ellipsis = "end",
  className,
}: CopyableIdProps) {
  const { copied, copy } = useCopyToClipboard({ timeout: 1400 });
  const onCopy = React.useCallback(() => void copy(value), [copy, value]);
  const shown =
    ellipsis === "middle" ? truncateMiddle(value, max) : truncate(value, max);

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : `Copy ${value}`}
      aria-label={`Copy ${label ?? "identifier"} ${value}`}
      className={cn(
        "group inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5",
        "font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        className,
      )}
    >
      {label && <span className="shrink-0 font-sans font-medium text-muted-foreground/80">{label}</span>}
      <span className="truncate">{shown}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <Copy className="size-3 shrink-0 opacity-60 group-hover:opacity-100" aria-hidden="true" />
      )}
    </button>
  );
}
