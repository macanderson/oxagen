"use client";

import { useCallback } from "react";
import { Copy, Check, Download } from "lucide-react";
import { useCopyToClipboard } from "@/components/ui/copy-button";
import { safeHref } from "@/lib/safe-url";

export interface SvgPreviewProps {
  /** Sanitized inline SVG markup string. */
  svg: string;
  /** Human-readable title shown above the graphic. */
  title: string;
  /**
   * Access-controlled serving URL (/api/v1/assets/gen_…) of the persisted SVG
   * conversation file. Present when the handler persisted the asset; enables
   * the Download affordance.
   */
  serveUrl?: string;
  /** Public id of the persisted generated_assets row (provenance, unused for render). */
  assetPublicId?: string;
}

/**
 * Renders a server-sanitized SVG inside a card.
 *
 * Security: the SVG is encoded as a data URI and set as an <img> src.
 * This prevents inline script execution at the browser level — the image
 * is parsed by the image decoder, not the HTML parser, so no script or
 * event handler in the SVG markup can run. No dangerouslySetInnerHTML is used.
 *
 * The Download button links to the access-controlled serving route with the
 * HTML `download` attribute, so mobile browsers save the file instead of
 * attempting (and failing) to navigate to an attachment-disposition SVG.
 *
 * The SVG should use currentColor and CSS custom properties so it adapts
 * automatically to the user's light/dark mode preference.
 */
export default function SvgPreview({ svg, title, serveUrl }: SvgPreviewProps) {
  const { copied, copy } = useCopyToClipboard({ timeout: 2000 });

  // Encode the SVG as a data URI using encodeURIComponent so it is safe to
  // embed as an <img> src. This is the XSS-safe rendering path.
  const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  const handleCopy = useCallback(() => void copy(svg), [copy, svg]);

  // The serving URL rides in with the handler's props, so the scheme is
  // allow-listed before it becomes a download href.
  const downloadHref = safeHref(serveUrl);

  return (
    <div
      className="group relative rounded-2xl border border-border bg-card text-card-foreground shadow-sm overflow-hidden transition-shadow hover:shadow-md"
      role="figure"
      aria-label={title}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-1 px-4 py-2 border-b border-border">
        <span className="text-sm font-medium text-foreground truncate pr-2">
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {downloadHref ? (
            <a
              href={downloadHref}
              download={`${title}.svg`}
              aria-label={`Download ${title} as SVG file`}
              // min-h/w-11 keeps a ≥44px touch target on mobile.
              className="flex min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Download className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Download</span>
            </a>
          ) : null}
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "SVG markup copied" : "Copy SVG markup"}
            className="flex min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {copied ? (
              <Check className="size-3.5 text-foreground" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
            <span className="hidden sm:inline">
              {copied ? "Copied" : "Copy SVG"}
            </span>
          </button>
        </div>
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
