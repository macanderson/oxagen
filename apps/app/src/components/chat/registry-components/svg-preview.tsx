"use client";

import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";

export interface SvgPreviewProps {
  /** Sanitized inline SVG markup string. */
  svg: string;
  /** Human-readable title shown above the graphic. */
  title: string;
}

/**
 * Renders a server-sanitized SVG inside a glass card.
 *
 * Security: the SVG is encoded as a data URI and set as an <img> src.
 * This prevents inline script execution at the browser level — the image
 * is parsed by the image decoder, not the HTML parser, so no script or
 * event handler in the SVG markup can run. No dangerouslySetInnerHTML is used.
 *
 * The SVG should use currentColor and CSS custom properties so it adapts
 * automatically to the user's light/dark mode preference.
 */
export default function SvgPreview({ svg, title }: SvgPreviewProps) {
  const [copied, setCopied] = useState(false);

  // Encode the SVG as a data URI using encodeURIComponent so it is safe to
  // embed as an <img> src. This is the XSS-safe rendering path.
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(svg);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied — fail silently.
    }
  }, [svg]);

  return (
    <div
      className="group relative rounded-2xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden transition-shadow hover:shadow-md"
      role="figure"
      aria-label={title}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-sm font-medium text-foreground truncate pr-2">
          {title}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "SVG markup copied" : "Copy SVG markup"}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? (
            <Check className="size-3.5 text-accent" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
          <span>{copied ? "Copied" : "Copy SVG"}</span>
        </button>
      </div>

      {/* SVG rendered via <img> — safe against XSS, adapts via CSS filters */}
      <div className="flex items-center justify-center p-6 bg-muted/30 dark:bg-muted/10 min-h-[200px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={dataUri}
          alt={title}
          className="max-w-full max-h-[400px] object-contain dark:invert-[0.05]"
          loading="lazy"
          decoding="async"
        />
      </div>
    </div>
  );
}
