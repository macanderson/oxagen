"use client";

/**
 * McpInstallTabs — client wrapper that provides the tabbed switcher for
 * per-client MCP install commands.
 *
 * Syntax highlighting is performed server-side (see page.tsx) and passed in as
 * pre-rendered HTML strings so this component stays lightweight: no Shiki
 * bundle lands in the client chunk.
 */

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Tabs, TabsList, TabsTab, TabsPanel, TabsIndicator } from "@/components/ui/tabs";

export interface McpTabEntry {
  /** Display label shown in the tab strip (e.g. "Claude Code"). */
  client: string;
  /** Unique key used as the Tabs `value` prop. */
  key: string;
  /** Raw command text — used by the copy button. */
  raw: string;
  /** Pre-rendered HTML from Shiki `codeToHtml`. Injected via dangerouslySetInnerHTML. */
  highlightedHtml: string;
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied — fail silently.
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <>
          <Check className="size-3.5 text-success" aria-hidden="true" />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3.5" aria-hidden="true" />
          Copy
        </>
      )}
    </button>
  );
}

/** Language tag shown in the code-frame header strip. */
function langLabel(key: string): string {
  return key === "claude_code" ? "bash" : "json";
}

// ---------------------------------------------------------------------------
// McpInstallTabs
// ---------------------------------------------------------------------------

export interface McpInstallTabsProps {
  entries: McpTabEntry[];
}

/**
 * Renders a tabbed code-block switcher. One tab per MCP client; each panel
 * shows the pre-highlighted snippet with a copy-to-clipboard button.
 *
 * Snippets are highlighted server-side with a single vibrant dark Shiki theme
 * (see page.tsx) and rendered on the always-dark `.ox-code-frame` terminal
 * surface, so the block reads identically — and high-contrast — in both light
 * and dark app modes.
 */
export function McpInstallTabs({ entries }: McpInstallTabsProps) {
  if (entries.length === 0) return null;

  // Safe: length guard above ensures at least one entry exists.
   
  const firstKey = entries[0]!.key;

  return (
    <Tabs defaultValue={firstKey}>
      {/* Tab strip */}
      <TabsList variant="underline" className="mb-0 relative">
        {entries.map((entry) => (
          <TabsTab key={entry.key} value={entry.key}>
            {entry.client}
          </TabsTab>
        ))}
        <TabsIndicator />
      </TabsList>

      {/* Panels */}
      {entries.map((entry) => (
        <TabsPanel key={entry.key} value={entry.key} className="mt-0">
          {/* Code block — a bold ember-framed dark terminal surface (see
              `.ox-code-frame` in globals.css). Identical in light and dark so it
              reads high-contrast on the light page. */}
          <div className="ox-code-frame group relative overflow-hidden rounded-b-xl rounded-tr-xl shadow-md">
            {/* Header strip: ember gradient dot + language tag · always-visible copy. */}
            <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
              <span className="flex items-center gap-2 font-mono text-[11px] text-white/50">
                <span
                  className="ox-grad-surface size-2.5 rounded-full"
                  aria-hidden="true"
                />
                {langLabel(entry.key)}
              </span>
              <CopyButton
                text={entry.raw}
                label={`${entry.client} install command`}
              />
            </div>

            {/*
             * Shiki-highlighted code injected as HTML.
             * Shiki emits a <pre><code> tree; we let it own the full block.
             * The wrapping div provides scroll containment.
             *
             * `[&_pre]:!bg-transparent` strips Shiki's inline theme bg so the
             * `.ox-code-frame` dark fill shows through.
             * `[&_pre]:overflow-x-auto` keeps long lines scrollable.
             * `[&_pre]:px-4 [&_pre]:py-3.5` sets the snippet padding.
             * `[&_code]:text-[13px] [&_code]:font-mono [&_code]:leading-relaxed`
             * sets the code typography. Token colours are baked inline by the
             * single dark Shiki theme; the frame's `--code-fg` covers the plain
             * text fallback if Shiki fails to load.
             */}
            <div
              data-mcp-code
              aria-label={`${entry.client} install command`}
               
              dangerouslySetInnerHTML={{ __html: entry.highlightedHtml }}
              className="[&_pre]:!bg-transparent [&_pre]:overflow-x-auto [&_pre]:px-4 [&_pre]:py-3.5 [&_code]:text-[13px] [&_code]:font-mono [&_code]:leading-relaxed"
            />
          </div>
        </TabsPanel>
      ))}
    </Tabs>
  );
}
