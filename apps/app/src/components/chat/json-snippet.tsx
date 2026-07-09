"use client";
/**
 * json-snippet.tsx — the deliberately plain renderer for bulky tool results.
 *
 * Some tool outputs (graph search hits, cypher rows) are big JSON documents
 * where the structured chip/grid tree (structured-value.tsx) turns into an
 * unreadable wall. For those, a developer wants exactly what they'd get in an
 * editor: the pretty-printed JSON, syntax highlighted, clipped to a sane
 * height, with a one-click copy — nothing fancier.
 *
 * Highlighting reuses the shared shiki singleton (diff-syntax.ts) and its
 * dual-theme `.diff-token` colour swap, so this stays in lockstep with the
 * diff card's look and pays no extra grammar/engine cost. Rendering never
 * blocks on the highlighter: the snippet appears instantly as plain mono text
 * and colours in when tokens resolve.
 */
import * as React from "react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  highlightLine,
  type HighlightedToken,
} from "./registry-components/diff-syntax";
import "./registry-components/diff-token.css";

/** Lines shown before the snippet clips behind a "show all" toggle. */
const DEFAULT_CLIP_LINES = 14;

/** Serialize to pretty JSON; never throws (mirrors safeJson in tool-call-card). */
export function toPrettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface JsonSnippetProps {
  /** The value to render; serialized with 2-space pretty printing. */
  value: unknown;
  /** Lines visible while clipped (default 14). */
  clipLines?: number;
  className?: string;
}

/**
 * A clipped, syntax-highlighted, pretty-printed JSON snippet with a copy icon
 * button. The standard presentation for large machine-shaped tool results.
 */
export function JsonSnippet({ value, clipLines = DEFAULT_CLIP_LINES, className }: JsonSnippetProps) {
  const json = React.useMemo(() => toPrettyJson(value), [value]);
  const lines = React.useMemo(() => json.split("\n"), [json]);
  const clippable = lines.length > clipLines;
  const [expanded, setExpanded] = React.useState(false);
  const visible = expanded ? lines : lines.slice(0, clipLines);

  // Highlight asynchronously; plain text renders first so nothing blocks.
  const [tokens, setTokens] = React.useState<HighlightedToken[][] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void Promise.all(lines.map((line) => highlightLine(line, "json"))).then((rows) => {
      if (!cancelled) setTokens(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [lines]);

  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable (insecure context) — no-op.
    }
  }, [json]);

  return (
    <div
      className={cn("group/snippet relative rounded-lg border border-border/60 bg-muted/30", className)}
      data-component="json-snippet"
    >
      <button
        type="button"
        onClick={onCopy}
        title={copied ? "Copied" : "Copy JSON"}
        aria-label="Copy JSON"
        className="absolute right-1.5 top-1.5 z-10 inline-flex items-center rounded-md border border-border/60 bg-card/90 p-1.5 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/snippet:opacity-100 hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
        {visible.map((line, i) => (
          <div key={i}>
            {tokens?.[i] ? (
              tokens[i].map((t, j) =>
                t.style ? (
                  <span key={j} className="diff-token" style={parseStyle(t.style)}>
                    {t.content}
                  </span>
                ) : (
                  <span key={j}>{t.content}</span>
                ),
              )
            ) : (
              line || " "
            )}
          </div>
        ))}
      </pre>
      {clippable ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t border-border/60 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" aria-hidden="true" />
              Collapse
            </>
          ) : (
            <>
              <ChevronDown className="size-3" aria-hidden="true" />
              Show all {lines.length} lines
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}

/**
 * highlightLine emits a CSS declaration string (`color:#x;--shiki-dark:#y`);
 * React needs an object. Custom properties pass through as-is.
 */
function parseStyle(style: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx <= 0) continue;
    const prop = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (!prop || !val) continue;
    // CSS custom properties keep their literal name; standard props camelCase.
    out[prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = val;
  }
  return out as React.CSSProperties;
}
