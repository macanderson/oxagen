/**
 * Syntax-highlighted, theme-aware unified-diff renderer for the REPL.
 *
 * Splits a unified `git diff` into classified lines (file header, hunk header,
 * added/removed/context code) and renders each with a colored +/- gutter plus
 * `cli-highlight` syntax highlighting of the code content. Parsing and
 * language inference are exported as pure helpers so they're unit-testable
 * without pulling in the Ink renderer.
 */
import { Box, Text } from "ink";
import React from "react";
import { highlight as highlightCode } from "cli-highlight";
import type { Theme as HighlightJsTheme } from "cli-highlight";
import {
  detectTerminalBackground,
  diffThemeFor,
  GITHUB_HIGHLIGHT_THEME,
  MONOKAI_HIGHLIGHT_THEME,
  type DiffTheme,
} from "../tui/terminal-theme.js";

/** Default cap on rendered diff lines before the view truncates with a note. */
const DEFAULT_MAX_LINES = 500;

export type DiffLineKind = "meta" | "hunk" | "add" | "del" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  /** The raw line as it appeared in the diff (including any +/-/space marker). */
  text: string;
  /** `text` with the leading +/-/space marker stripped (meta/hunk lines: same as `text`). */
  code: string;
}

const META_PREFIXES = [
  "diff --git",
  "index ",
  "--- ",
  "+++ ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "Binary files",
  "\\ No newline",
];

const HUNK_HEADER = /^@@ .*@@/;

/**
 * Parse a unified diff into classified, marker-stripped lines. Pure — no Ink,
 * no highlighting — so it's cheap to unit-test independent of rendering.
 */
export function parseDiffLines(diff: string): DiffLine[] {
  const rawLines = diff.split(/\r?\n/);
  // A diff ending in "\n" produces a trailing "" element from split() that
  // doesn't correspond to a real line; drop it so we don't render a phantom
  // blank context row.
  if (diff.endsWith("\n") && rawLines[rawLines.length - 1] === "")
    rawLines.pop();

  return rawLines.map((text): DiffLine => {
    if (META_PREFIXES.some((prefix) => text.startsWith(prefix))) {
      return { kind: "meta", text, code: text };
    }
    if (HUNK_HEADER.test(text)) {
      return { kind: "hunk", text, code: text };
    }
    if (text.startsWith("+")) {
      return { kind: "add", text, code: text.slice(1) };
    }
    if (text.startsWith("-")) {
      return { kind: "del", text, code: text.slice(1) };
    }
    if (text.startsWith(" ")) {
      return { kind: "context", text, code: text.slice(1) };
    }
    // Blank line or anything else unrecognized inside a hunk body reads as context.
    return { kind: "context", text, code: text };
  });
}

/** A {@link DiffLine} annotated with its old-file and/or new-file line number. */
export interface NumberedDiffLine extends DiffLine {
  /** Line number in the OLD file (context + removed lines); undefined for added/meta/hunk. */
  oldLine?: number;
  /** Line number in the NEW file (context + added lines); undefined for removed/meta/hunk. */
  newLine?: number;
}

/** Parses `@@ -<oldStart>[,n] +<newStart>[,m] @@`, tolerating the omitted-count form. */
const HUNK_RANGE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Annotate each diff line with its source line numbers. Pure: walks the lines,
 * resetting counters at every hunk header (`@@ -old +new @@`), then advancing
 * the old counter on context/removed lines and the new counter on
 * context/added lines. Meta and hunk lines carry no numbers.
 */
export function numberDiffLines(lines: DiffLine[]): NumberedDiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return lines.map((line): NumberedDiffLine => {
    if (line.kind === "hunk") {
      const m = HUNK_RANGE.exec(line.text);
      if (m) {
        oldLine = Number.parseInt(m[1]!, 10);
        newLine = Number.parseInt(m[2]!, 10);
      }
      return { ...line };
    }
    if (line.kind === "meta") return { ...line };
    if (line.kind === "context") {
      const numbered = { ...line, oldLine, newLine };
      oldLine++;
      newLine++;
      return numbered;
    }
    if (line.kind === "del") {
      const numbered = { ...line, oldLine };
      oldLine++;
      return numbered;
    }
    // add
    const numbered = { ...line, newLine };
    newLine++;
    return numbered;
  });
}

/** Gutter column widths: the max old/new line-number digit count, floored at 3. */
export interface GutterWidths {
  oldWidth: number;
  newWidth: number;
}

/** Compute {@link GutterWidths} for a set of numbered lines (min 3 per column). */
export function computeGutterWidths(lines: NumberedDiffLine[]): GutterWidths {
  let maxOld = 0;
  let maxNew = 0;
  for (const line of lines) {
    if (line.oldLine !== undefined) maxOld = Math.max(maxOld, line.oldLine);
    if (line.newLine !== undefined) maxNew = Math.max(maxNew, line.newLine);
  }
  return {
    oldWidth: Math.max(3, String(maxOld).length),
    newWidth: Math.max(3, String(maxNew).length),
  };
}

/** Right-aligned `<old> <new>│` gutter text; blank columns keep alignment for meta/hunk/add/del. */
function gutterText(line: NumberedDiffLine, widths: GutterWidths): string {
  const oldStr = line.oldLine !== undefined ? String(line.oldLine) : "";
  const newStr = line.newLine !== undefined ? String(line.newLine) : "";
  return `${oldStr.padStart(widths.oldWidth)} ${newStr.padStart(widths.newWidth)}│`;
}

/** File-extension → `cli-highlight` language id, for common source types. */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  sql: "sql",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  php: "php",
  kt: "kotlin",
  swift: "swift",
  toml: "ini",
  ini: "ini",
  graphql: "graphql",
  gql: "graphql",
};

/** Infer a `cli-highlight` language id from a file path's extension, or `undefined` if unknown/none. */
export function languageForPath(path: string): string | undefined {
  const match = /\.([a-zA-Z0-9]+)$/.exec(path);
  const extension = match?.[1];
  if (!extension) return undefined;
  return EXTENSION_LANGUAGE[extension.toLowerCase()];
}

/** Pull the changed file's path out of a diff's `+++ b/<path>` header, if present. */
function inferLanguageFromDiff(diff: string): string | undefined {
  const match = /^\+\+\+ b\/(.+)$/m.exec(diff);
  const rawPath = match?.[1];
  if (!rawPath) return undefined;
  const path = rawPath.trim();
  if (path === "/dev/null") return undefined;
  return languageForPath(path);
}

/**
 * Resolve a {@link DiffTheme}'s `highlightjs` field to a concrete
 * `cli-highlight` `Theme`. Accepts an already-concrete token map as-is, or
 * resolves the two named built-ins.
 */
export function resolveHighlightTheme(
  selection: DiffTheme["highlightjs"],
): HighlightJsTheme {
  if (selection === "github") return GITHUB_HIGHLIGHT_THEME;
  if (selection === "monokai") return MONOKAI_HIGHLIGHT_THEME;
  return selection;
}

/**
 * Syntax-highlight `code` for terminal output. Defensive: `cli-highlight` can
 * throw on some inputs even with `ignoreIllegals`, so any failure falls back
 * to the plain, unhighlighted code rather than crashing the view.
 */
function safeHighlight(
  code: string,
  language: string | undefined,
  theme: HighlightJsTheme,
): string {
  if (!code) return code;
  try {
    return highlightCode(code, { language, ignoreIllegals: true, theme });
  } catch {
    return code;
  }
}

export interface DiffLineRowProps {
  /** The (optionally numbered) line to render. */
  line: NumberedDiffLine;
  /** Resolved diff color theme (concrete, not inferred). */
  theme: DiffTheme;
  /** Resolved `cli-highlight` language id, or undefined for no highlighting. */
  language: string | undefined;
  /** Pre-resolved `cli-highlight` token theme (resolve once, reuse per row). */
  hlTheme: HighlightJsTheme;
  /** When set, prefixes a right-aligned old/new line-number gutter of these widths. */
  gutter?: GutterWidths;
}

/**
 * Renders one unified-diff line: an optional dim line-number gutter, a colored
 * +/-/space marker (for code lines), and syntax-highlighted code content.
 * Shared by {@link DiffView} and the `/diff` panel so the gutter + highlight
 * logic lives in exactly one place.
 */
export function DiffLineRow({
  line,
  theme,
  language,
  hlTheme,
  gutter,
}: DiffLineRowProps): React.ReactElement {
  const gutterEl = gutter ? (
    <Text color={theme.lineNumber} dimColor>
      {gutterText(line, gutter)}
    </Text>
  ) : null;

  if (line.kind === "meta") {
    return (
      <Box>
        {gutterEl}
        <Text color={theme.meta} dimColor>
          {line.text}
        </Text>
      </Box>
    );
  }
  if (line.kind === "hunk") {
    return (
      <Box>
        {gutterEl}
        <Text color={theme.hunk} bold>
          {line.text}
        </Text>
      </Box>
    );
  }

  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
  const markerColor =
    line.kind === "add"
      ? theme.addEmphasis
      : line.kind === "del"
        ? theme.delEmphasis
        : theme.context;
  const codeColor =
    line.kind === "add"
      ? theme.add
      : line.kind === "del"
        ? theme.del
        : theme.context;
  const highlighted = safeHighlight(line.code, language, hlTheme);

  return (
    <Box>
      {gutterEl}
      <Text color={markerColor} bold={line.kind !== "context"}>
        {marker}
      </Text>
      <Text color={codeColor}>{highlighted}</Text>
    </Box>
  );
}

export interface DiffViewProps {
  /** Unified `git diff` text. */
  diff: string;
  /** Diff color theme; defaults to the theme for the detected terminal background. */
  theme?: DiffTheme;
  /** `cli-highlight` language id; inferred from the `+++ b/<path>` header when omitted. */
  language?: string;
  /** Max lines to render before truncating with a summary note. Default 500. */
  maxLines?: number;
  /**
   * Render a dim right-aligned old/new line-number gutter before each row.
   * Default false so existing usages are unchanged.
   */
  showLineNumbers?: boolean;
}

/** Renders a unified diff with a colored +/- gutter and syntax-highlighted code content. */
export function DiffView({
  diff,
  theme,
  language,
  maxLines = DEFAULT_MAX_LINES,
  showLineNumbers = false,
}: DiffViewProps): React.ReactElement {
  const resolvedTheme = theme ?? diffThemeFor(detectTerminalBackground());
  const hlTheme = resolveHighlightTheme(resolvedTheme.highlightjs);
  const resolvedLanguage = language ?? inferLanguageFromDiff(diff);
  const lines = numberDiffLines(parseDiffLines(diff));
  const truncated = lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;
  const gutter = showLineNumbers ? computeGutterWidths(visible) : undefined;

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <DiffLineRow
          key={i}
          line={line}
          theme={resolvedTheme}
          language={resolvedLanguage}
          hlTheme={hlTheme}
          gutter={gutter}
        />
      ))}
      {truncated && (
        <Text dimColor>
          … ({lines.length - maxLines} more lines — scroll or /replay to see
          all)
        </Text>
      )}
    </Box>
  );
}
