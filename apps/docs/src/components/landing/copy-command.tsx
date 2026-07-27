"use client";

import { useState } from "react";

/**
 * CopyCommand — an inline, copyable command pill for the landing page. Shows a
 * `$` prompt + the command in mono, with a copy button that confirms for ~1.5s.
 * Icons are inline SVG so the docs app needs no extra dependency.
 */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy: ${command}`}
      className="group inline-flex items-center gap-3 rounded-lg border border-border bg-card/60 px-4 py-2.5 font-mono text-sm text-foreground backdrop-blur transition-colors hover:border-[var(--_ember-flame,#FF7E5F)]/60"
    >
      <span className="select-none text-[var(--_ember-flame,#FF7E5F)]">$</span>
      <span>{command}</span>
      <span className="ml-1 text-muted-foreground transition-colors group-hover:text-foreground">
        {copied ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M20 6 9 17l-5-5"
              stroke="#38d39f"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="9"
              y="9"
              width="11"
              height="11"
              rx="2.2"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M5 15V5a2 2 0 0 1 2-2h10"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>
    </button>
  );
}
