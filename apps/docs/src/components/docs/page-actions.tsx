"use client";

import { useEffect, useRef, useState } from "react";

interface PageActionsProps {
  /**
   * Absolute path to the page's raw-Markdown endpoint,
   * e.g. `/llms.mdx/docs/security/overview`.
   */
  markdownUrl: string;
  /**
   * Filename stem for the downloaded `.md` file (no extension),
   * e.g. `security-overview`.
   */
  fileStem: string;
}

type CopyState = "idle" | "copied" | "error";

/**
 * PageActions — a compact, dependency-free actions menu shown on every docs
 * page. Lets a reader take the page's content elsewhere:
 *
 * - Copy as Markdown — fetches the raw-Markdown endpoint and copies it.
 * - Download .md — same content, saved as `<stem>.md`.
 * - Export PDF — `window.print()`; print CSS in global.css strips the chrome
 *   (sidebar / subnav / TOC / this menu) so only the article prints.
 * - Open llms.txt — the site-wide LLM index.
 *
 * Styling uses Fumadocs' own `fd-*` design tokens so it matches the theme in
 * light and dark without any new dependency.
 */
export function PageActions({ markdownUrl, fileStem }: PageActionsProps) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside-click and Escape so the menu behaves like a real popover.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function fetchMarkdown(): Promise<string> {
    const res = await fetch(markdownUrl);
    if (!res.ok) throw new Error(`Failed to load Markdown (${res.status})`);
    return res.text();
  }

  async function handleCopy() {
    try {
      const text = await fetchMarkdown();
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 2000);
    }
    setOpen(false);
  }

  async function handleDownload() {
    try {
      const text = await fetchMarkdown();
      const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileStem}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 2000);
    }
    setOpen(false);
  }

  function handlePrint() {
    setOpen(false);
    // Let the menu close (and unmount from the print layout) before printing.
    setTimeout(() => window.print(), 0);
  }

  const itemClass =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-fd-popover-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:bg-fd-accent focus-visible:outline-none";

  return (
    <div
      ref={rootRef}
      data-docs-page-actions
      className="relative not-prose shrink-0"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-fd-border bg-fd-card px-2.5 py-1.5 text-sm font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
      >
        {copyState === "copied" ? (
          <>
            <CheckIcon />
            Copied
          </>
        ) : (
          <>
            <PageIcon />
            {copyState === "error" ? "Copy failed" : "This page"}
            <ChevronIcon open={open} />
          </>
        )}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute end-0 z-40 mt-1.5 w-56 origin-top-end rounded-lg border border-fd-border bg-fd-popover p-1 shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleCopy}
            className={itemClass}
          >
            <CopyIcon />
            Copy as Markdown
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleDownload}
            className={itemClass}
          >
            <DownloadIcon />
            Download .md
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handlePrint}
            className={itemClass}
          >
            <PrinterIcon />
            Export PDF
          </button>
          <a
            role="menuitem"
            href="/llms.txt"
            target="_blank"
            rel="noreferrer"
            onClick={() => setOpen(false)}
            className={itemClass}
          >
            <RobotIcon />
            Open llms.txt
          </a>
        </div>
      ) : null}
    </div>
  );
}

/* ── Inline icons (no dependency; 16px stroke glyphs) ───────────────────── */

function iconProps() {
  return {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function PageIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M5 21V5a2 2 0 0 1 2-2h7l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function PrinterIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" rx="1" />
    </svg>
  );
}

function RobotIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V4" />
      <circle cx="9" cy="14" r="1" />
      <circle cx="15" cy="14" r="1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      {...iconProps()}
      className={`transition-transform ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
