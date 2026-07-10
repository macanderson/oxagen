"use client";

/**
 * TruncatedText — the app-wide primitive for showing long text in dense list /
 * table / key-value surfaces without forcing the user to scroll past a wall of
 * wrapped lines.
 *
 * Behaviour (per product rule):
 *   - The inline preview is clamped to `lines` lines. When the source is
 *     markdown we strip the syntax first so the preview never shows raw
 *     markdown *language* (no stray `#`, `*`, `|`). See markdownToPlainText.
 *   - When (and only when) the content actually overflows the clamp, we render
 *     an ellipsis "…" trigger. Clicking it opens a popover that shows the
 *     COMPLETE content — formatted as styled HTML when `markdown` is set,
 *     otherwise as preserved plain text.
 *
 * This keeps every long-text cell readable at a glance while making the full
 * value one click away, everywhere the component is used.
 */

import * as React from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownContent } from "@/components/ui/markdown-content";
import { markdownToPlainText } from "./markdown-preview";
import { cn } from "@/lib/utils";

export interface TruncatedTextProps {
  /** The full text (markdown or plain) to display. */
  text: string;
  /** Number of lines to clamp the preview to. Default 2. */
  lines?: number;
  /**
   * When true, the source is treated as markdown: the preview is stripped to
   * plain prose and the reveal popover renders styled HTML. Default true.
   */
  markdown?: boolean;
  /** Extra classes for the clamped preview text. */
  className?: string;
  /** Extra classes for the reveal popover surface. */
  popoverClassName?: string;
  /** Accessible label for the reveal trigger. */
  revealLabel?: string;
}

const CLAMP_CLASS: Record<number, string> = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
};

export function TruncatedText({
  text,
  lines = 2,
  markdown = true,
  className,
  popoverClassName,
  revealLabel = "Show full text",
}: TruncatedTextProps) {
  const previewRef = React.useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  const preview = React.useMemo(
    () => (markdown ? markdownToPlainText(text) : text),
    [markdown, text],
  );

  // Detect overflow after layout and on resize so the reveal affordance only
  // appears when the clamp actually hides content.
  React.useLayoutEffect(() => {
    const el = previewRef.current;
    if (!el) return;

    const measure = () => {
      // A 1px tolerance avoids sub-pixel false positives.
      setOverflowing(el.scrollHeight - el.clientHeight > 1);
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [preview, lines]);

  const clampClass = CLAMP_CLASS[lines] ?? "line-clamp-2";

  return (
    <span className={cn("inline-flex max-w-full items-start gap-1", className)}>
      <span
        ref={previewRef}
        className={cn("min-w-0 whitespace-pre-wrap break-words", clampClass)}
      >
        {preview}
      </span>

      {overflowing ? (
        <Popover>
          <PopoverTrigger
            aria-label={revealLabel}
            title={revealLabel}
            className="shrink-0 rounded px-1 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <span aria-hidden="true">…</span>
          </PopoverTrigger>
          <PopoverPopup
            className={cn(
              "max-h-[60vh] w-[min(32rem,90vw)] overflow-auto",
              popoverClassName,
            )}
          >
            {markdown ? (
              <MarkdownContent>{text}</MarkdownContent>
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {text}
              </p>
            )}
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}
