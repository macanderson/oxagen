/**
 * diff-syntax — client-side, dual-theme (light + dark) syntax highlighting for
 * the individual code lines rendered by `code-diff-card`.
 *
 * Why not `codeToHtml`? The diff card renders each source line inside its own
 * grid row (gutter columns + a `+`/`-`/` ` marker), so we need *per-line* token
 * data — a colour for every fragment of a line — not a single pre-rendered
 * `<pre>` block. Shiki's `codeToTokens` gives exactly that.
 *
 * Dual themes with ZERO runtime theme JS: Shiki is asked for both
 * `github-light` and `github-dark`. With two themes it emits, per token, an
 * `htmlStyle` carrying `color: <light>` plus a `--shiki-dark: <dark>` CSS
 * variable. We render each token with that style and a `.dark` selector (see
 * `diff-token.css`) that swaps `color` to `var(--shiki-dark)`. The app toggles
 * dark mode with the `.dark` class (`@custom-variant dark (&:is(.dark *))`), so
 * the diff follows the theme with no re-highlight and no flash.
 *
 * The highlighter is a lazily-created singleton restricted to a common language
 * set + a small theme pair, so the WASM/oniguruma engine and grammars load once
 * and stay resident for every diff card on the page.
 */

import type { Highlighter } from "shiki";

/** Themes highlighted for every token (light first, dark second). */
export const DIFF_THEMES = ["github-light", "github-dark"] as const;

/**
 * Languages the diff highlighter loads. Kept deliberately small — the common
 * languages an agent edits in this repo — so the grammar payload stays modest.
 * Anything outside this set (or an unknown extension) falls back to `plaintext`,
 * which renders uncoloured but still correctly (never throws).
 */
const SUPPORTED_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "css",
  "html",
  "markdown",
  "python",
  "rust",
  "go",
  "java",
  "sql",
  "yaml",
  "bash",
  "toml",
] as const;

type SupportedLang = (typeof SUPPORTED_LANGS)[number];

/**
 * Map a file path/extension to one of the highlighter's loaded languages.
 * Returns `"plaintext"` for anything unknown — the highlighter treats that as a
 * no-grammar language and returns a single plain token per line.
 */
export function inferLang(path: string): SupportedLang | "plaintext" {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "sass":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "sql":
      return "sql";
    case "yml":
    case "yaml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "toml":
      return "toml";
    default:
      return "plaintext";
  }
}

let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Lazily create (once) and return the shared dual-theme highlighter. Loads only
 * the theme pair and the `SUPPORTED_LANGS` grammars via the top-level `shiki`
 * package (already an app dependency and the same entrypoint the MCP install
 * snippets use), so the WASM engine + grammars initialise a single time and
 * stay resident for every diff card on the page.
 */
async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const { createHighlighter } = await import("shiki");
      return createHighlighter({
        themes: [...DIFF_THEMES],
        langs: [...SUPPORTED_LANGS],
      });
    })();
  }
  return highlighterPromise;
}

/** A single highlighted fragment of a source line. */
export interface HighlightedToken {
  content: string;
  /**
   * Inline style carrying the light colour (`color`) and the dark colour
   * (`--shiki-dark` CSS var). `diff-token.css` flips `color` to the dark var
   * under `.dark`. `undefined` for plaintext / unknown languages.
   */
  style?: string;
}

/**
 * Tokenize one line of source into dual-theme coloured fragments.
 *
 * Robust by construction: any failure (grammar miss, engine error) resolves to
 * a single uncoloured token holding the whole line, so a highlight problem
 * degrades to plain text and never breaks the diff render.
 */
export async function highlightLine(
  line: string,
  lang: SupportedLang | "plaintext",
): Promise<HighlightedToken[]> {
  if (line.length === 0) return [{ content: "" }];
  if (lang === "plaintext") return [{ content: line }];
  try {
    const highlighter = await getHighlighter();
    // codeToTokens with two themes yields per-token `htmlStyle` with the light
    // colour + a `--shiki-dark` var. One line in → one row of tokens out.
    const { tokens } = highlighter.codeToTokens(line, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light",
    });
    const row = tokens[0] ?? [];
    return row.map((t) => ({
      content: t.content,
      style: normalizeStyle(t.htmlStyle),
    }));
  } catch {
    return [{ content: line }];
  }
}

/**
 * Shiki's `htmlStyle` is `string | Record<string,string>` depending on version.
 * Collapse either form into a single CSS declaration string (or `undefined`).
 */
function normalizeStyle(
  htmlStyle: string | Record<string, string> | undefined,
): string | undefined {
  if (!htmlStyle) return undefined;
  if (typeof htmlStyle === "string") return htmlStyle;
  const decls = Object.entries(htmlStyle).map(([k, v]) => `${k}:${v}`);
  return decls.length > 0 ? decls.join(";") : undefined;
}

/** Test seam: reset the memoized highlighter (used only by unit tests). */
export function __resetDiffHighlighter(): void {
  highlighterPromise = null;
}
