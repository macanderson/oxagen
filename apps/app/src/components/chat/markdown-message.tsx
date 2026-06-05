"use client";

/**
 * MarkdownMessage — shared Streamdown wrapper for all agent text rendering.
 *
 * Both injection points (StreamingText live reveal and MessageBubble persisted
 * blocks) import this single component so Shiki theme config, Mermaid config,
 * and all hardening options live in exactly one place.
 *
 * Light/dark theming strategy:
 *   - Code blocks: Shiki dual-theme output (`github-light` / `github-dark`)
 *     emits `--shiki-light` / `--shiki-dark` CSS variables as inline token
 *     styles. Streamdown renders tokens with `dark:text-[var(--shiki-dark,...)]`
 *     Tailwind utilities, so switching is automatic via the `.dark` class on
 *     `<html>` — no JS theme detection, no flash, no extra context read.
 *   - Mermaid: a single `neutral` theme is used because it is the most legible
 *     across both light and dark canvases without requiring a JS theme-switch.
 *     Override via CSS `[data-streamdown="mermaid"] svg` if needed.
 *
 * Tailwind v4 @source lines for the Streamdown/plugin dist files are registered
 * in apps/app/src/app/globals.css so all utility classes in the bundles are
 * generated at build time.
 */

import * as React from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { createMermaidPlugin } from "@streamdown/mermaid";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Plugin instances — created once at module scope (stateless, shareable).
// ---------------------------------------------------------------------------

/**
 * Shiki code-highlighting plugin.
 * `[light, dark]` tuple: Streamdown renders both theme outputs as inline CSS
 * variables and switches via Tailwind's `dark:` variant (`.dark` on `<html>`).
 */
const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

/**
 * Mermaid diagram plugin.
 * `neutral` theme reads well on both the light card background and dark canvas
 * without any runtime theme-switching. SecurityLevel `strict` (default)
 * prevents script injection from untrusted diagram content.
 */
const mermaidPlugin = createMermaidPlugin({
  config: {
    theme: "neutral",
    securityLevel: "strict",
    startOnLoad: false,
  },
});

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MarkdownMessageProps {
  /** Markdown content string (may be partial/unterminated when streaming). */
  children: string;
  /**
   * Pass `true` while content is still streaming so remend's incomplete-block
   * handling keeps partial fenced code, links, etc. from rendering as broken
   * HTML. Safe to leave `true` on static/persisted content — has no runtime
   * overhead once the string is complete.
   */
  streaming?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MarkdownMessage({ children, streaming = false, className }: MarkdownMessageProps) {
  return (
    <Streamdown
      /**
       * remend preprocessor: close unterminated markdown blocks so the HAST
       * tree never sees half-open fences, bold markers, etc. during streaming.
       * Streamdown defaults this to `true` but we are explicit for clarity.
       */
      parseIncompleteMarkdown={streaming}
      /**
       * Dual Shiki themes. Streamdown injects inline `--shiki-light` /
       * `--shiki-dark` CSS vars per token and toggles between them with the
       * `dark:` Tailwind variant — zero JS required for theme switching.
       */
      shikiTheme={["github-light", "github-dark"]}
      /**
       * Mermaid config forwarded to the plugin at render time. `neutral` theme
       * is readable on both the `bg-card` light surface and the `.dark` canvas.
       */
      mermaid={{
        config: {
          theme: "neutral",
          securityLevel: "strict",
          startOnLoad: false,
        },
      }}
      /**
       * Register both plugins: code highlighting (Shiki) + diagram rendering
       * (Mermaid). Math and CJK are omitted — add here if needed.
       */
      plugins={{
        code: codePlugin,
        mermaid: mermaidPlugin,
      }}
      /**
       * Show copy/download controls on code blocks and mermaid diagrams.
       * Disable table fullscreen (not needed in chat bubbles).
       */
      controls={{
        code: { copy: true, download: false },
        mermaid: { copy: true, download: true, fullscreen: true, panZoom: true },
        table: { copy: true, download: true, fullscreen: false },
      }}
      /**
       * linkSafety: default `true` — Streamdown shows a confirmation modal
       * before navigating to external URLs. Leave enabled for security.
       */
      className={cn(
        // Prose-width constraint and responsive flow
        "max-w-none",
        // Ensure mermaid diagrams + code blocks don't overflow narrow viewports
        "[&_pre]:overflow-x-auto [&_pre]:max-w-full",
        "[&_.mermaid]:max-w-full [&_.mermaid]:overflow-x-auto",
        // Responsive tables
        "[&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full",
        // Comfortable vertical rhythm for chat context
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      {children}
    </Streamdown>
  );
}
