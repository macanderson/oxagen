"use client";

import * as React from "react";
import { Check, ChevronDown, ChevronRight, Copy, FileCode } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * code-diff-card — renders a set of unified-diff file patches from a
 * coding-agent action (e.g. agent.repo.edit, repo.file.put) as a collapsible,
 * per-file diff view instead of a raw JSON blob.
 *
 * componentId: "code-diff"
 */

export interface CodeDiffFile {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface CodeDiffCardProps {
  files: CodeDiffFile[];
}

export type DiffLineType = "add" | "del" | "context" | "meta";

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/**
 * Hand-rolled unified-diff hunk parser — no dependency needed for the subset
 * of the format every git/GitHub patch string uses: a `@@ -a,b +c,d @@` hunk
 * header followed by ` ` (context) / `+` (add) / `-` (del) / `\` (no-newline
 * marker) lines. File-header lines (`--- a/...`, `+++ b/...`) that precede
 * the first hunk are skipped — the card already shows the path in its own
 * header, so they'd be redundant noise.
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  if (!patch) return [];
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      current = { header: line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1) });
    } else if (line.startsWith("\\")) {
      current.lines.push({ type: "meta", content: line });
    } else {
      current.lines.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
      });
    }
  }
  return hunks;
}

const LINE_BG: Record<DiffLineType, string> = {
  add: "bg-success/10",
  del: "bg-destructive/10",
  context: "",
  meta: "italic text-muted-foreground/70",
};

const LINE_PREFIX: Record<DiffLineType, string> = {
  add: "+",
  del: "-",
  context: " ",
  meta: "\\",
};

const LINE_PREFIX_CLASS: Record<DiffLineType, string> = {
  add: "text-success",
  del: "text-destructive",
  context: "text-muted-foreground/40",
  meta: "text-muted-foreground/40",
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = React.useCallback(() => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard access denied — fail silently, matches install-instructions.tsx.
      });
  }, [text]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className="inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="size-3.5" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

function DiffFileSection({ file }: { file: CodeDiffFile }) {
  const [open, setOpen] = React.useState(true);
  const hunks = React.useMemo(() => parseUnifiedDiff(file.patch), [file.patch]);

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${file.path}` : `Expand ${file.path}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="truncate font-mono text-xs" title={file.path}>
            {file.path}
          </span>
        </button>
        <Badge variant="success" className="shrink-0 tabular-nums">
          +{file.additions}
        </Badge>
        <Badge variant="destructive" className="shrink-0 tabular-nums">
          -{file.deletions}
        </Badge>
        {/*
         * "Open file" affordance stub — intentionally NOT wired to routing yet.
         * A later workspace-file-viewer PR can point this at the real route;
         * for now it's a visible, keyboard-accessible no-op so the affordance
         * exists in the UI ahead of that wiring.
         */}
        <button
          type="button"
          onClick={() => {
            /* no-op stub — see comment above */
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${file.path}`}
        >
          <FileCode className="size-3.5" aria-hidden="true" />
          Open
        </button>
        <CopyButton text={file.patch} label={`diff for ${file.path}`} />
      </div>
      {open ? (
        <div className="px-3 pb-3">
          {hunks.length === 0 ? (
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              No diff preview available for this file.
            </p>
          ) : (
            <div className="space-y-2">
              {hunks.map((hunk, hi) => (
                <div key={hi} className="overflow-x-auto rounded-lg border border-border/60">
                  <div className="bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                    {hunk.header}
                  </div>
                  <pre className="font-mono text-xs leading-relaxed">
                    {hunk.lines.map((line, li) => (
                      <div
                        key={li}
                        className={cn("whitespace-pre px-2 py-0.5", LINE_BG[line.type])}
                      >
                        <span
                          className={cn("mr-1 select-none", LINE_PREFIX_CLASS[line.type])}
                          aria-hidden="true"
                        >
                          {LINE_PREFIX[line.type]}
                        </span>
                        {line.content.length > 0 ? line.content : " "}
                      </div>
                    ))}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function CodeDiffCard({ files }: CodeDiffCardProps) {
  if (files.length === 0) {
    return (
      <div
        className="my-2 rounded-xl border bg-card p-4 text-sm text-card-foreground shadow"
        data-component="code-diff-card"
      >
        <p className="text-xs text-muted-foreground">No file changes to display.</p>
      </div>
    );
  }

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border bg-card text-sm text-card-foreground shadow"
      data-component="code-diff-card"
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 dark:bg-muted/20">
        <span className="text-xs font-semibold text-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <Badge variant="success" className="tabular-nums">
          +{totalAdditions}
        </Badge>
        <Badge variant="destructive" className="tabular-nums">
          -{totalDeletions}
        </Badge>
      </div>
      <div>
        {files.map((file, i) => (
          <DiffFileSection key={`${file.path}:${i}`} file={file} />
        ))}
      </div>
    </div>
  );
}
