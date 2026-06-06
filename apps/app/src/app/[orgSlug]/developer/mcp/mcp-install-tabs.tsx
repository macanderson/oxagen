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
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";

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
      className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="size-3.5 text-green-500" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
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
 * Shiki dual-theme CSS vars (`--shiki-light` / `--shiki-dark`) are set as
 * inline token styles by `codeToHtml`; the `.dark` class on `<html>` switches
 * them via the Tailwind `dark:` variant — zero JS required for theme switching.
 */
export function McpInstallTabs({ entries }: McpInstallTabsProps) {
  if (entries.length === 0) return null;

  // Safe: length guard above ensures at least one entry exists.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const firstKey = entries[0]!.key;

  return (
    <Tabs defaultValue={firstKey}>
      {/* Tab strip */}
      <TabsList className="mb-0">
        {entries.map((entry) => (
          <TabsTab key={entry.key} value={entry.key}>
            {entry.client}
          </TabsTab>
        ))}
      </TabsList>

      {/* Panels */}
      {entries.map((entry) => (
        <TabsPanel key={entry.key} value={entry.key} className="mt-0">
          {/* Code block wrapper — matches the surrounding card style */}
          <div className="group relative overflow-hidden rounded-b-xl rounded-tr-xl border border-border/40 bg-muted/50">
            {/* Copy button — positioned top-right */}
            <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity group-hover:opacity-100">
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
             * `[&_pre]:!bg-transparent` strips Shiki's inline bg so our
             * Tailwind `bg-muted/50` shows through.
             * `[&_pre]:overflow-x-auto` keeps long lines scrollable.
             * `[&_pre]:px-4 [&_pre]:py-3` matches the original snippet padding.
             * `[&_code]:text-xs [&_code]:font-mono [&_code]:leading-relaxed`
             * matches the surrounding typography.
             *
             * Shiki light/dark vars:
             *   color tokens → `--shiki-light` (used by default)
             *   dark override → `dark:` class on <html> flips to `--shiki-dark`
             * The CSS for the var-swap lives in globals.css via Streamdown's
             * @source registration, which covers the same dual-theme output.
             */}
            <div
              data-mcp-code
              aria-label={`${entry.client} install command`}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: entry.highlightedHtml }}
              className="[&_pre]:!bg-transparent [&_pre]:overflow-x-auto [&_pre]:px-4 [&_pre]:py-3 [&_code]:text-xs [&_code]:font-mono [&_code]:leading-relaxed"
            />
          </div>
        </TabsPanel>
      ))}
    </Tabs>
  );
}
