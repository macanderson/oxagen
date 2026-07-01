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
  if (diff.endsWith("\n") && rawLines[rawLines.length - 1] === "") rawLines.pop();

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
function resolveHighlightTheme(selection: DiffTheme["highlightjs"]): HighlightJsTheme {
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

export interface DiffViewProps {
  /** Unified `git diff` text. */
  diff: string;
  /** Diff color theme; defaults to the theme for the detected terminal background. */
  theme?: DiffTheme;
  /** `cli-highlight` language id; inferred from the `+++ b/<path>` header when omitted. */
  language?: string;
  /** Max lines to render before truncating with a summary note. Default 500. */
  maxLines?: number;
}

/** Renders a unified diff with a colored +/- gutter and syntax-highlighted code content. */
export function DiffView({
  diff,
  theme,
  language,
  maxLines = DEFAULT_MAX_LINES,
}: DiffViewProps): React.ReactElement {
  const resolvedTheme = theme ?? diffThemeFor(detectTerminalBackground());
  const hlTheme = resolveHighlightTheme(resolvedTheme.highlightjs);
  const resolvedLanguage = language ?? inferLanguageFromDiff(diff);
  const lines = parseDiffLines(diff);
  const truncated = lines.length > maxLines;
  const visible = truncated ? lines.slice(0, maxLines) : lines;

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => {
        if (line.kind === "meta") {
          return (
            <Text key={i} color={resolvedTheme.meta} dimColor>
              {line.text}
            </Text>
          );
        }
        if (line.kind === "hunk") {
          return (
            <Text key={i} color={resolvedTheme.hunk} bold>
              {line.text}
            </Text>
          );
        }

        const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
        const markerColor =
          line.kind === "add"
            ? resolvedTheme.addEmphasis
            : line.kind === "del"
              ? resolvedTheme.delEmphasis
              : resolvedTheme.context;
        const codeColor =
          line.kind === "add"
            ? resolvedTheme.add
            : line.kind === "del"
              ? resolvedTheme.del
              : resolvedTheme.context;
        const highlighted = safeHighlight(line.code, resolvedLanguage, hlTheme);

        return (
          <Box key={i}>
            <Text color={markerColor} bold={line.kind !== "context"}>
              {marker}
            </Text>
            <Text color={codeColor}>{highlighted}</Text>
          </Box>
        );
      })}
      {truncated && (
        <Text dimColor>
          … ({lines.length - maxLines} more lines — scroll or /replay to see all)
        </Text>
      )}
    </Box>
  );
}
