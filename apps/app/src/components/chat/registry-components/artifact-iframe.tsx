"use client";

import * as React from "react";
import { Code2, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HtmlArtifactProps {
  /** The raw HTML string to render inside the sandboxed iframe. */
  html: string;
  /** Title shown in the header bar. */
  title?: string;
}

type ActiveTab = "preview" | "source";

/**
 * Sandboxed iframe artifact renderer.
 *
 * componentId: "html-artifact"
 *
 * Security contract:
 *  - sandbox="allow-scripts" — scripts may run INSIDE the frame.
 *  - allow-same-origin is intentionally ABSENT: the frame gets an opaque
 *    origin, so it cannot access the parent's cookies, localStorage, or DOM.
 *  - referrerPolicy="no-referrer" — no referrer header leaks on sub-requests.
 *  - No allow-forms, allow-top-navigation, allow-popups etc.
 *
 * This makes the INLINE PREVIEW safe to embed arbitrary model-generated HTML
 * without risk of session hijacking or parent-frame access.
 *
 * The "Open in new tab" action does NOT share that guarantee — see the note on
 * `handleOpenInNew` below.
 */
export default function HtmlArtifact({
  html,
  title = "Artifact",
}: HtmlArtifactProps) {
  const [activeTab, setActiveTab] = React.useState<ActiveTab>("preview");
  const [expanded, setExpanded] = React.useState(false);

  // Open the html in a new tab via a blob URL.
  //
  // WARNING — this escapes the iframe sandbox above. A `blob:` URL INHERITS the
  // creating document's origin, so the new tab runs the model-authored HTML as
  // first-party script on the app's own origin: it can read non-HttpOnly
  // cookies and localStorage and issue credentialed same-origin API calls.
  // `noopener` severs `window.opener`; it does not change the origin. Serving
  // the artifact from an opaque origin (a dedicated sandboxed route, or a
  // separate artifact host) is the fix — see the audit finding on this file.
  //
  // `window.open` with `noopener` returns null in every current browser, so the
  // revocation always takes the timeout path; the `win` branch is kept for the
  // engines that still hand back a handle.
  const handleOpenInNew = React.useCallback(() => {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, "_blank", "noopener,noreferrer");
    // Revoke the object URL after the window has loaded to avoid memory leaks.
    if (win) {
      win.addEventListener("load", () => URL.revokeObjectURL(blobUrl), {
        once: true,
      });
    } else {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    }
  }, [html]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        expanded && "fixed inset-4 z-50 m-0 rounded-xl shadow-2xl",
      )}
      role="region"
      aria-label={`HTML artifact: ${title}`}
    >
      {/* Header bar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        {/* Title */}
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
          title={title}
        >
          {title}
        </span>

        {/* Tab switcher */}
        <div
          className="flex rounded-md border border-border bg-background text-xs"
          role="tablist"
          aria-label="Artifact view"
        >
          <button
            role="tab"
            aria-selected={activeTab === "preview"}
            aria-controls="artifact-preview-panel"
            onClick={() => setActiveTab("preview")}
            className={cn(
              "rounded-l-md px-2.5 py-1 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeTab === "preview"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Preview
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "source"}
            aria-controls="artifact-source-panel"
            onClick={() => setActiveTab("source")}
            className={cn(
              "rounded-r-md px-2.5 py-1 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeTab === "source"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Code2 className="inline size-3 mr-0.5" aria-hidden="true" />
            Source
          </button>
        </div>

        {/* Action buttons */}
        <button
          onClick={handleOpenInNew}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md",
            "text-muted-foreground hover:bg-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "transition-colors",
          )}
          aria-label="Open in new tab"
          title="Open in new tab"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-md",
            "text-muted-foreground hover:bg-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "transition-colors",
          )}
          aria-label={expanded ? "Collapse artifact" : "Expand artifact"}
          aria-expanded={expanded}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <Minimize2 className="size-3.5" aria-hidden="true" />
          ) : (
            <Maximize2 className="size-3.5" aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Preview panel */}
      <div
        id="artifact-preview-panel"
        role="tabpanel"
        aria-label="Preview"
        hidden={activeTab !== "preview"}
        className="contents"
      >
        {activeTab === "preview" ? (
          <iframe
            // Security: allow-scripts only — no allow-same-origin.
            // The frame gets an opaque origin; it cannot read parent cookies,
            // localStorage, or access the parent DOM.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={html}
            title={title}
            className={cn(
              "block w-full border-none",
              expanded ? "h-[calc(100%-40px)]" : "h-80",
            )}
            aria-label={`Live preview: ${title}`}
          />
        ) : null}
      </div>

      {/* Source panel */}
      <div
        id="artifact-source-panel"
        role="tabpanel"
        aria-label="Source code"
        hidden={activeTab !== "source"}
        className={cn(activeTab === "source" ? "block" : "hidden")}
      >
        <pre
          className={cn(
            "overflow-auto bg-muted/50 p-4 font-mono text-xs leading-relaxed text-foreground",
            expanded ? "h-[calc(100%-40px)]" : "max-h-80",
          )}
        >
          <code>{html}</code>
        </pre>
      </div>
    </div>
  );
}
