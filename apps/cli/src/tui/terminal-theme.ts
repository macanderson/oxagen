/**
 * Terminal background detection and the diff color theme derived from it.
 *
 * Kept dependency-free (no `cli-highlight`, no Ink) so `detectTerminalBackground`
 * is a pure function of `process.env` and is trivially unit-testable. The
 * `highlightjs` field of {@link DiffTheme} is typed to accept either a plain
 * `Record` of chalk-style token formatters or one of the two named built-in
 * theme maps ({@link GITHUB_HIGHLIGHT_THEME} / {@link MONOKAI_HIGHLIGHT_THEME})
 * — resolving the string literal into a concrete `cli-highlight` `Theme` object
 * is `diff-view.tsx`'s job, so this module never has to import that package.
 */

export type TerminalBackground = "light" | "dark";

/** COLORFGBG background-color indices that indicate a dark terminal background. */
const DARK_BG_INDICES = new Set([0, 1, 2, 3, 4, 5, 6, 8]);
/** COLORFGBG background-color indices that indicate a light terminal background. */
const LIGHT_BG_INDICES = new Set([7, 9, 10, 11, 12, 13, 14, 15]);

/**
 * Detect whether the terminal's background is light or dark. Pure and
 * synchronous — safe to call anywhere, including at module load.
 *
 * Detection order:
 * 1. `env.OXAGEN_TERMINAL_BG` — explicit override (`"light"` | `"dark"`) wins
 *    outright, checked before anything else.
 * 2. `env.COLORFGBG` — many terminals (xterm, konsole, most Linux terminals)
 *    set this as `"fg;bg"` or `"fg;default;bg"`. The *last* `;`-separated
 *    field is the background color index; 0–6 and 8 are dark palette slots,
 *    7 and 9–15 are light palette slots.
 * 3. Fallback: `"dark"`, the common terminal default.
 */
export function detectTerminalBackground(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBackground {
  const override = env.OXAGEN_TERMINAL_BG;
  if (override === "light" || override === "dark") return override;

  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const fields = colorfgbg.split(";");
    const last = fields[fields.length - 1]?.trim();
    const index = last === undefined || last === "" ? NaN : Number(last);
    if (Number.isInteger(index)) {
      if (LIGHT_BG_INDICES.has(index)) return "light";
      if (DARK_BG_INDICES.has(index)) return "dark";
    }
    // Unrecognized index (malformed or out-of-range): fall through to default.
  }

  return "dark";
}

/**
 * Best-effort async detection via the OSC 11 "query background color" escape
 * sequence, for terminals that don't set `COLORFGBG` (many modern emulators —
 * iTerm2, WezTerm, Ghostty, Kitty — support OSC 11 but not COLORFGBG). Always
 * resolves; never throws. Falls back to {@link detectTerminalBackground} when
 * there's no TTY, the terminal doesn't answer within `timeoutMs`, or anything
 * about the query/parse fails.
 */
export function queryTerminalBackground(
  stdout: NodeJS.WriteStream,
  stdin: NodeJS.ReadStream,
  timeoutMs = 200,
): Promise<TerminalBackground> {
  return new Promise((resolve) => {
    const fallback = (): void => resolve(detectTerminalBackground());

    try {
      if (!stdout.isTTY || !stdin.isTTY) {
        fallback();
        return;
      }

      const wasRaw = stdin.isRaw ?? false;
      let settled = false;

      const finish = (bg: TerminalBackground): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdin.removeListener("data", onData);
        try {
          if (!wasRaw) stdin.setRawMode?.(false);
        } catch {
          // Best-effort cleanup only — never let raw-mode restore throw.
        }
        resolve(bg);
      };

      let buffer = "";
      const onData = (chunk: Buffer | string): void => {
        buffer += chunk.toString("utf8");
        // Reply shape: ESC ] 11 ; rgb:RRRR/GGGG/BBBB (ST|BEL)
        const match =
          /rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})/.exec(
            buffer,
          );
        if (!match) return;
        const [, rHex, gHex, bHex] = match;
        if (!rHex || !gHex || !bHex) return;
        try {
          const r = parseInt(rHex.slice(0, 2), 16);
          const g = parseInt(gHex.slice(0, 2), 16);
          const b = parseInt(bHex.slice(0, 2), 16);
          // Perceptual luminance (Rec. 601), normalized to 0–1.
          const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          finish(luminance > 0.5 ? "light" : "dark");
        } catch {
          finish(detectTerminalBackground());
        }
      };

      const timer = setTimeout(
        () => finish(detectTerminalBackground()),
        timeoutMs,
      );
      timer.unref?.();

      try {
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on("data", onData);
        stdout.write("\u001b]11;?\u0007");
      } catch {
        finish(detectTerminalBackground());
      }
    } catch {
      fallback();
    }
  });
}

// ── Diff color theme ────────────────────────────────────────────────────────

/**
 * A chalk-style token formatter map compatible with `cli-highlight`'s `Theme`
 * type (`Record<token, (codePart: string) => string>`), kept structurally
 * loose here so this module doesn't need to depend on the `cli-highlight`
 * package just to describe its shape.
 */
export type HighlightThemeMap = Record<string, (codePart: string) => string>;

export interface DiffTheme {
  /** Color for added-line code content. */
  add: string;
  /** Color for the `+` gutter marker (and other added-line emphasis). */
  addEmphasis: string;
  /** Color for removed-line code content. */
  del: string;
  /** Color for the `-` gutter marker (and other removed-line emphasis). */
  delEmphasis: string;
  /** Color for `@@ ... @@` hunk headers. */
  hunk: string;
  /** Color for file-header metadata lines (`diff --git`, `index`, `---`, `+++`). */
  meta: string;
  /** Color for unchanged context lines. */
  context: string;
  /** Color for line-number gutters, where rendered. */
  lineNumber: string;
  /**
   * The `cli-highlight` theme to use for syntax-highlighting code content.
   * Either a concrete token-formatter map, or one of the two named built-in
   * maps below (resolved to a concrete map by the diff renderer).
   */
  highlightjs: HighlightThemeMap | "github" | "monokai";
}

/** Wraps `s` in a 256-color ANSI foreground escape (SGR 38;5;n), reset after. */
function fg(code: number): (s: string) => string {
  return (s: string) => `\u001b[38;5;${code}m${s}\u001b[39m`;
}

/**
 * A dark, high-contrast token palette loosely modeled on Monokai — used as the
 * default `highlightjs` theme for {@link DARK_DIFF_THEME}.
 */
export const MONOKAI_HIGHLIGHT_THEME: HighlightThemeMap = {
  keyword: fg(197),
  built_in: fg(81),
  type: fg(81),
  literal: fg(141),
  number: fg(141),
  regexp: fg(186),
  string: fg(186),
  symbol: fg(141),
  class: fg(148),
  function: fg(148),
  title: fg(148),
  params: fg(255),
  comment: fg(102),
  doctag: fg(102),
  meta: fg(102),
  section: fg(197),
  tag: fg(197),
  name: fg(197),
  attr: fg(208),
  attribute: fg(208),
  variable: fg(208),
  bullet: fg(186),
  link: fg(81),
  quote: fg(102),
  "selector-tag": fg(197),
  "selector-id": fg(148),
  "selector-class": fg(148),
  "template-variable": fg(208),
  addition: fg(148),
  deletion: fg(197),
};

/**
 * A light, muted token palette loosely modeled on GitHub's light diff view —
 * used as the default `highlightjs` theme for {@link LIGHT_DIFF_THEME}.
 */
export const GITHUB_HIGHLIGHT_THEME: HighlightThemeMap = {
  keyword: fg(160),
  built_in: fg(25),
  type: fg(25),
  literal: fg(88),
  number: fg(28),
  regexp: fg(22),
  string: fg(22),
  symbol: fg(88),
  class: fg(94),
  function: fg(94),
  title: fg(94),
  params: fg(238),
  comment: fg(243),
  doctag: fg(243),
  meta: fg(243),
  section: fg(160),
  tag: fg(88),
  name: fg(88),
  attr: fg(130),
  attribute: fg(130),
  variable: fg(130),
  bullet: fg(22),
  link: fg(25),
  quote: fg(243),
  "selector-tag": fg(88),
  "selector-id": fg(94),
  "selector-class": fg(94),
  "template-variable": fg(130),
  addition: fg(28),
  deletion: fg(160),
};

/** Diff theme for dark-background terminals: bright greens/reds on assumed-dark bg. */
export const DARK_DIFF_THEME: DiffTheme = {
  add: "#34D399",
  addEmphasis: "#6EE7B7",
  del: "#FB7185",
  delEmphasis: "#FCA5A5",
  hunk: "#7C5AED",
  meta: "gray",
  context: "#D1D5DB",
  lineNumber: "gray",
  highlightjs: MONOKAI_HIGHLIGHT_THEME,
};

/** Diff theme for light-background terminals: darker green/red shades legible on white. */
export const LIGHT_DIFF_THEME: DiffTheme = {
  add: "#15803D",
  addEmphasis: "#166534",
  del: "#B91C1C",
  delEmphasis: "#7F1D1D",
  hunk: "#6D28D9",
  meta: "#6B7280",
  context: "#374151",
  lineNumber: "#9CA3AF",
  highlightjs: GITHUB_HIGHLIGHT_THEME,
};

/** Returns the concrete {@link DiffTheme} for a detected terminal background. */
export function diffThemeFor(bg: TerminalBackground): DiffTheme {
  return bg === "light" ? LIGHT_DIFF_THEME : DARK_DIFF_THEME;
}
