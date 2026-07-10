"use client";

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Check, Copy, ExternalLink, FileDiff } from "lucide-react";
import { cn } from "@/lib/utils";
import { diffAnchorId } from "./diff-anchor";
import { highlightLine, inferLang, type HighlightedToken } from "./diff-syntax";
import "./diff-token.css";

/**
 * code-diff-card — renders a unified-diff patch set produced by a
 * coding-agent action (agent.repo.edit, repo.file.put) or an explicit
 * `agent.ui.render` call with `componentId: "code-diff"`.
 *
 * componentId: "code-diff"
 *
 * Props are FLAT and component-specific (not the generic capability-result
 * envelope): `files` is the sole required field. Neither `agent.repo.edit`
 * nor `repo.file.put`'s output schema carries a full unified-diff patch body
 * today (repo.edit exposes only changed file PATHS; repo.file.put exposes a
 * commit URL) — packages/oxagen/src/capability-meta.ts reshapes those outputs
 * into this props shape via a structural transform, so `patch` is commonly
 * `null`/absent and the card degrades to a path-only row with an external
 * link. A future contract change that returns real patch text needs no card
 * changes — `parseUnifiedDiff` already renders full hunks when `patch` is set.
 *
 * Syntax highlighting: when a file's patch has hunks, each code line is
 * tokenized client-side by Shiki (`./diff-syntax`) with a dual light+dark theme
 * pair (`github-light` / `github-dark`). Tokens render with the light colour
 * inline plus a `--shiki-dark` CSS variable; `./diff-token.css` swaps to the
 * dark colour under the app's `.dark` class — so the diff matches the terminal
 * agentic-coding look and follows the theme with no JS re-highlight. Rendering
 * never blocks on highlighting: the diff shows immediately as plain text and
 * upgrades to colours when tokenization resolves; unknown languages stay plain.
 */

export interface CodeDiffFile {
  /** Repo-relative file path. */
  path: string;
  /** Unified-diff patch body for this file, or null/absent when unavailable. */
  patch?: string | null;
  /** Added-line count; recomputed from `patch` when omitted. */
  additions?: number | null;
  /** Removed-line count; recomputed from `patch` when omitted. */
  deletions?: number | null;
}

export interface CodeDiffCardProps {
  files: CodeDiffFile[];
  /** Optional short description shown above the file list (e.g. agent summary). */
  summary?: string;
  /** Optional external URL (PR, commit) shown as a "View" link. */
  externalUrl?: string;
  /** Label for the external link, e.g. "PR #42" or "commit a1b2c3d". */
  externalLabel?: string;
}

export interface DiffLine {
  type: "add" | "del" | "context";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Hand-rolled unified-diff parser — no dependency exists in the tree for this
 * (grepped packages/*, apps/app/package.json for "diff"/"unidiff"/"parse-diff";
 * only packages/agent depends on `diff`, and adding it to apps/app would
 * duplicate a capability apps/app doesn't otherwise need). Only handles the
 * subset needed to render hunks: `@@ … @@` headers, `+`/`-`/` ` line prefixes,
 * and the "\ No newline at end of file" marker. File-level `---`/`+++`
 * headers preceding the first hunk are intentionally skipped — the file path
 * is already shown in the card header.
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const hunkMatch = HUNK_HEADER_RE.exec(raw);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1] ?? "0", 10);
      newLine = parseInt(hunkMatch[2] ?? "0", 10);
      current = { header: raw, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue; // pre-hunk file headers (---/+++) — skip
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) {
      current.lines.push({ type: "add", content: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      current.lines.push({ type: "del", content: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else {
      const content = raw.startsWith(" ") ? raw.slice(1) : raw;
      current.lines.push({ type: "context", content, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

/** Count added/removed lines across all hunks of a patch. */
export function countDiffStats(hunks: DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions += 1;
      else if (line.type === "del") deletions += 1;
    }
  }
  return { additions, deletions };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
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
        <Check className="size-3.5 text-success" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * A single diff line. When Shiki tokens are available (`tokens`) the code is
 * rendered as syntax-highlighted spans; otherwise it falls back to plain text.
 * The add/del row tint and the `+`/`-`/` ` marker are always applied — token
 * colours sit ON TOP of the row background, exactly like a coding-agent UI.
 */
function DiffLineRow({ line, tokens }: { line: DiffLine; tokens?: HighlightedToken[] }) {
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <div
      className={cn(
        "grid grid-cols-[2.5rem_2.5rem_1fr] gap-0 font-mono text-xs leading-relaxed",
        line.type === "add" && "bg-success/10",
        line.type === "del" && "bg-error/10",
      )}
    >
      <span className="select-none px-2 text-right text-muted-foreground/60 tabular-nums">
        {line.oldLine ?? ""}
      </span>
      <span className="select-none px-2 text-right text-muted-foreground/60 tabular-nums">
        {line.newLine ?? ""}
      </span>
      <span className="whitespace-pre px-2">
        <span
          aria-hidden="true"
          className={cn(
            "select-none",
            line.type === "add" && "text-success",
            line.type === "del" && "text-error",
          )}
        >
          {marker}
        </span>
        {tokens && tokens.length > 0 ? (
          tokens.map((t, i) => (
            <span key={i} className="diff-token" style={parseTokenStyle(t.style)}>
              {t.content}
            </span>
          ))
        ) : (
          <span
            className={cn(line.type === "add" && "text-success", line.type === "del" && "text-error")}
          >
            {line.content}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Convert a Shiki inline style string (`color:#x;--shiki-dark:#y`) into a React
 * style object. React rejects a raw CSS string on `style`, so we split it into
 * a keyed object, preserving the `--shiki-dark` custom property the `.dark`
 * rule in diff-token.css reads.
 */
export function parseTokenStyle(style: string | undefined): React.CSSProperties | undefined {
  if (!style) return undefined;
  const out: Record<string, string> = {};
  for (const decl of style.split(";")) {
    const idx = decl.indexOf(":");
    if (idx <= 0) continue;
    const key = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (!key || !value) continue;
    // camelCase standard props; keep custom properties (--shiki-*) verbatim.
    const prop = key.startsWith("--")
      ? key
      : key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    out[prop] = value;
  }
  return out as React.CSSProperties;
}

/**
 * Highlight every code line across a file's hunks with Shiki, returning a map
 * keyed by `"<hunkIndex>:<lineIndex>"` → token list. Runs once per file in an
 * effect (client-only), so the diff renders as plain text immediately and
 * upgrades to syntax colours when highlighting resolves — never blocking paint
 * and never throwing (highlightLine degrades to plain text on any failure).
 */
function useHighlightedHunks(path: string, hunks: DiffHunk[]): Map<string, HighlightedToken[]> {
  const [map, setMap] = useState<Map<string, HighlightedToken[]>>(() => new Map());
  // Stable dependency: the concatenated code content + path (language source).
  const signature = useMemo(
    () => `${path}\u0000${hunks.map((h) => h.lines.map((l) => l.content).join("\n")).join("\u0001")}`,
    [path, hunks],
  );

  useEffect(() => {
    let cancelled = false;
    const lang = inferLang(path);
    if (lang === "plaintext") {
      setMap(new Map());
      return;
    }
    (async () => {
      const next = new Map<string, HighlightedToken[]>();
      for (let hi = 0; hi < hunks.length; hi += 1) {
        const lines = hunks[hi]?.lines ?? [];
        for (let li = 0; li < lines.length; li += 1) {
          const content = lines[li]?.content ?? "";
          // Sequential await against the shared singleton highlighter keeps
          // memory flat for large diffs (no burst of parallel tokenizations).
          const tokens = await highlightLine(content, lang);
          next.set(`${hi}:${li}`, tokens);
        }
      }
      if (!cancelled) setMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [signature, hunks, path]);

  return map;
}

function FileSection({ file, defaultOpen }: { file: CodeDiffFile; defaultOpen: boolean }) {
  const hunks = useMemo(() => (file.patch ? parseUnifiedDiff(file.patch) : []), [file.patch]);
  const highlighted = useHighlightedHunks(file.path, hunks);
  const computed = hunks.length > 0 ? countDiffStats(hunks) : null;
  const additions = file.additions ?? computed?.additions ?? 0;
  const deletions = file.deletions ?? computed?.deletions ?? 0;

  return (
    <details
      id={diffAnchorId(file.path)}
      open={defaultOpen}
      className="group border-b border-border last:border-b-0"
      data-file-path={file.path}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <FileDiff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
          {file.path}
        </span>
        {(additions > 0 || deletions > 0) && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
            {additions > 0 && <span className="text-success">+{additions}</span>}
            {deletions > 0 && <span className="text-error">-{deletions}</span>}
          </span>
        )}
        {file.patch ? (
          <span onClick={(e) => e.stopPropagation()}>
            <CopyButton text={file.patch} label={`diff for ${file.path}`} />
          </span>
        ) : null}
      </summary>

      {hunks.length > 0 ? (
        <div className="overflow-x-auto border-t border-border/60 bg-muted/20">
          {hunks.map((hunk, hi) => (
            <div key={hi}>
              <div className="bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => (
                <DiffLineRow key={li} line={line} tokens={highlighted.get(`${hi}:${li}`)} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="border-t border-border/60 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
          No diff content available for this file in this result.
        </p>
      )}
    </details>
  );
}

export default function CodeDiffCard({
  files,
  summary,
  externalUrl,
  externalLabel,
}: CodeDiffCardProps): ReactElement {
  const totals = files.reduce(
    (acc, f) => {
      const hunks = f.patch ? parseUnifiedDiff(f.patch) : [];
      const computed = hunks.length > 0 ? countDiffStats(hunks) : null;
      acc.additions += f.additions ?? computed?.additions ?? 0;
      acc.deletions += f.deletions ?? computed?.deletions ?? 0;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );

  if (files.length === 0) {
    return (
      <div
        className="my-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        data-component="code-diff-card"
      >
        No files changed.
      </div>
    );
  }

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="code-diff-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <span className="text-xs text-muted-foreground">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        {(totals.additions > 0 || totals.deletions > 0) && (
          <span className="flex items-center gap-1.5 font-mono text-xs tabular-nums">
            {totals.additions > 0 && <span className="text-success">+{totals.additions}</span>}
            {totals.deletions > 0 && <span className="text-error">-{totals.deletions}</span>}
          </span>
        )}
        {externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {externalLabel ?? "View"}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>

      {summary ? (
        <p className="border-b border-border/60 px-4 py-2 text-sm text-foreground">{summary}</p>
      ) : null}

      <div>
        {files.map((file, i) => (
          <FileSection key={file.path} file={file} defaultOpen={files.length === 1 || i === 0} />
        ))}
      </div>
    </div>
  );
}
