"use client";
import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "../lib/utils";
import { Button, type ButtonProps } from "./button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./tooltip";

/*
 * CopyButton — the shared copy-to-clipboard affordance.
 *
 * Replaces the ~20 hand-rolled `navigator.clipboard.writeText` + Copy/Check
 * icon swaps across surfaces. Ghost icon button by default; on success the
 * icon crossfades to a check (success token) with a small scale pop, announces
 * "Copied" to screen readers, and reverts after a beat.
 *
 *   <CopyButton value={apiKey} />
 *   <CopyButton value={id} size="icon-sm" variant="outline" label="Copy ID" />
 */
/**
 * useCopyToClipboard — shared clipboard write + transient "copied" flag.
 * Use directly when the trigger chrome is bespoke; otherwise use <CopyButton>.
 */
export function useCopyToClipboard({
  timeout = 1500,
}: {
  timeout?: number;
} = {}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = React.useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard unavailable (permissions/insecure context) — stay at rest.
        return false;
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), timeout);
      return true;
    },
    [timeout],
  );

  return { copied, copy };
}

export interface CopyButtonProps
  extends Omit<ButtonProps, "value" | "onCopy" | "children"> {
  /** Text written to the clipboard (or a lazy producer for expensive payloads). */
  value: string | (() => string);
  /** Tooltip + accessible name at rest. */
  label?: string;
  /** Tooltip + announcement after a successful copy. */
  copiedLabel?: string;
  /** How long the copied state persists, in ms. */
  timeout?: number;
  /** Called after a successful clipboard write. */
  onCopied?: () => void;
}

const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      value,
      label = "Copy",
      copiedLabel = "Copied",
      timeout = 1500,
      onCopied,
      className,
      variant = "ghost",
      size = "icon-sm",
      onClick,
      ...props
    },
    ref,
  ) => {
    const { copied, copy } = useCopyToClipboard({ timeout });

    const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      const text = typeof value === "function" ? value() : value;
      if (await copy(text)) onCopied?.();
    };

    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={ref}
              variant={variant}
              size={size}
              aria-label={copied ? copiedLabel : label}
              onClick={handleClick}
              className={className}
              {...props}
            />
          }
        >
          <span className="relative inline-flex size-4 items-center justify-center">
            {/* Crossfade + pop between the two icons; transform-only, token-timed. */}
            <Copy
              aria-hidden="true"
              className={cn(
                "absolute size-3.5 transition-[opacity,transform,translate,scale] duration-[var(--motion-micro)] ease-[var(--ease-hover)]",
                copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
              )}
            />
            <Check
              aria-hidden="true"
              className={cn(
                "absolute size-3.5 text-success transition-[opacity,transform,translate,scale] duration-[var(--motion-micro)] ease-[var(--ease-hover)]",
                copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
              )}
            />
          </span>
          <span aria-live="polite" className="sr-only">
            {copied ? copiedLabel : ""}
          </span>
        </TooltipTrigger>
        <TooltipPopup>{copied ? copiedLabel : label}</TooltipPopup>
      </Tooltip>
    );
  },
);
CopyButton.displayName = "CopyButton";

export { CopyButton };
