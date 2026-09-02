"use client";

import * as React from "react";
import { Copy, Check, Code2, Download } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MermaidDiagramProps {
  /** Mermaid diagram source text. */
  source: string;
  /** Human-readable title shown in the card heading. */
  title: string;
  /** Mermaid theme. Defaults to 'default'. */
  theme?: "default" | "dark" | "neutral" | "forest";
  /**
   * Access-controlled serving URL (/api/v1/assets/gen_…) of the persisted
   * .mmd source conversation file. Present when the handler persisted the
   * source; enables the Download affordance.
   */
  sourceUrl?: string;
  /** Public id of the persisted generated_assets row (provenance, unused for render). */
  assetPublicId?: string;
}

type RenderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; svg: string }
  | { status: "error"; message: string };

/**
 * Renders a Mermaid diagram inline in chat.
 *
 * componentId: "mermaid-diagram"
 *
 * Implementation notes:
 *   - The 'mermaid' npm package is imported lazily (dynamic import) so its
 *     bundle is only loaded the first time a mermaid-diagram component is
 *     rendered. Subsequent renders reuse the cached module.
 *   - Mermaid renders to SVG in the browser — no server-side Chromium/JSDOM
 *     is involved. This satisfies the serverless pure-JS constraint.
 *   - The rendered SVG is set via dangerouslySetInnerHTML. Mermaid's own
 *     output is trusted (it sanitises its inputs); the source comes from an
 *     agent, not from untrusted end-user HTML.
 *   - A stable, per-render ID is derived from the source hash so Mermaid
 *     can re-render safely without ID collisions between diagram instances.
 */
export default function MermaidDiagram({
  source,
  title,
  theme = "default",
  sourceUrl,
}: MermaidDiagramProps) {
  const [state, setState] = React.useState<RenderState>({ status: "idle" });
  const [showSource, setShowSource] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Stable element ID for this diagram instance, derived from content.
  const diagramId = React.useId();
  const containerId = `mermaid-${diagramId.replace(/:/g, "")}`;

  React.useEffect(() => {
    let cancelled = false;

    async function render() {
      setState({ status: "loading" });
      try {
        const mermaid = (await import("mermaid")).default;

        mermaid.initialize({
          startOnLoad: false,
          theme,
          // Suppress console output from Mermaid's internal parser warnings.
          suppressErrorRendering: true,
        });

        const { svg } = await mermaid.render(containerId, source);

        if (!cancelled) {
          setState({ status: "success", svg });
        }
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Failed to render diagram";
          setState({ status: "error", message });
        }
      }
    }

    void render();

    return () => {
      cancelled = true;
    };
  }, [source, theme, containerId]);

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied — fail silently.
    }
  }, [source]);

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      role="figure"
      aria-label={`Mermaid diagram: ${title}`}
    >
      {/* Header bar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
          title={title}
        >
          {title}
        </span>

        {/* Source toggle */}
        <button
          onClick={() => setShowSource((v) => !v)}
          aria-pressed={showSource}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            showSource
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          title={showSource ? "Hide source" : "Show source"}
          aria-label={
            showSource ? "Hide Mermaid source" : "Show Mermaid source"
          }
        >
          <Code2 className="size-3" aria-hidden="true" />
          <span>Source</span>
        </button>

        {/* Download persisted .mmd source (present when the handler persisted
            the diagram as a conversation file) */}
        {sourceUrl ? (
          <a
            href={sourceUrl}
            download={`${title}.mmd`}
            aria-label={`Download ${title} diagram source`}
            title="Download diagram source (.mmd)"
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Download className="size-3" aria-hidden="true" />
            <span>Download</span>
          </a>
        ) : null}

        {/* Copy button */}
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Source copied" : "Copy diagram source"}
          className={cn(
            "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {copied ? (
            <Check className="size-3 text-foreground" aria-hidden="true" />
          ) : (
            <Copy className="size-3" aria-hidden="true" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>

      {/* Diagram panel */}
      {!showSource && (
        <div className="flex min-h-[180px] items-center justify-center p-4">
          {state.status === "idle" || state.status === "loading" ? (
            <div
              className="flex flex-col items-center gap-2 text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <svg
                className="size-5 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v8H4z"
                />
              </svg>
              <span className="text-xs">Rendering diagram…</span>
            </div>
          ) : state.status === "error" ? (
            <div
              className="flex flex-col items-center gap-2 text-destructive"
              role="alert"
            >
              <p className="text-xs font-medium">Failed to render diagram</p>
              <p className="max-w-[320px] break-words text-center font-mono text-xs text-muted-foreground">
                {state.message}
              </p>
            </div>
          ) : (
            <div
              // Mermaid's own SVG output is trusted; it sanitises its own markup.
              // The source is agent-produced diagram DSL, never raw end-user HTML.
              dangerouslySetInnerHTML={{ __html: state.svg }}
              className="max-w-full overflow-auto [&_svg]:max-w-full [&_svg]:h-auto"
              aria-label={title}
            />
          )}
        </div>
      )}

      {/* Source panel */}
      {showSource && (
        <pre className="overflow-auto bg-muted/50 p-4 font-mono text-xs leading-relaxed text-foreground max-h-72">
          <code>{source}</code>
        </pre>
      )}
    </div>
  );
}
