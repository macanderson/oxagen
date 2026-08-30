import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import { useTerminalSize } from "../repl/use-terminal-size.js";

// 5-row block glyphs, kept as literals so the wordmark renders identically
// across terminals (no figlet dependency). Every glyph is a fixed-width
// 5-line column; words are composed by joining glyph rows with a single
// space so letters never touch.
const GLYPHS: Record<string, readonly string[]> = {
  O: [" ██████ ", "██    ██", "██    ██", "██    ██", " ██████ "],
  X: ["██   ██", " ██ ██ ", "  ███  ", " ██ ██ ", "██   ██"],
  A: [" █████ ", "██   ██", "███████", "██   ██", "██   ██"],
  G: [" ██████ ", "██      ", "██   ███", "██    ██", " ██████ "],
  E: ["███████", "██     ", "█████  ", "██     ", "███████"],
  N: ["███    ██", "████   ██", "██ ██  ██", "██  ██ ██", "██   ████"],
  S: ["███████", "██     ", "███████", "     ██", "███████"],
  H: ["██   ██", "██   ██", "███████", "██   ██", "██   ██"],
  C: [" ██████", "██     ", "██     ", "██     ", " ██████"],
  L: ["██     ", "██     ", "██     ", "██     ", "███████"],
  I: ["██", "██", "██", "██", "██"],
  ".": ["  ", "  ", "  ", "  ", "██"],
  " ": ["  ", "  ", "  ", "  ", "  "],
};

const GLYPH_ROWS = 5;

/** Compose a word into its 5-row block-letter form. Unknown chars are skipped. */
function compose(text: string): string[] {
  const letters = [...text.toUpperCase()]
    .map((ch) => GLYPHS[ch])
    .filter(Boolean) as ReadonlyArray<readonly string[]>;
  return Array.from({ length: GLYPH_ROWS }, (_, row) =>
    letters.map((g) => g[row]).join(" "),
  );
}

// Block-letter OXAGEN wordmark. Exported so other one-shot reveal animations
// (see tui/init-reveal.ts) share this exact wordmark instead of forking their
// own copy. Also the Banner's narrow-terminal fallback: the full
// "OXAGEN.SH CLI" mark below needs ~92 columns, this one only ~51.
export const WORDMARK: string[] = compose("OXAGEN");

/** Full "OXAGEN.SH CLI" wordmark — the REPL banner on terminals wide enough to fit it. */
export const WORDMARK_FULL: string[] = compose("OXAGEN.SH CLI");

const WORDMARK_WIDTH = WORDMARK[0]?.length ?? 0;
const WORDMARK_FULL_WIDTH = WORDMARK_FULL[0]?.length ?? 0;

// ── Sunset gradient ──────────────────────────────────────────────────────────
// Amber → orange → red → burnt red, swept left-to-right across the wordmark.
const SUNSET_STOPS = ["#FBBF24", "#F97316", "#EF4444", "#B91C1C"] as const;

function hexChannel(hex: string, i: number): number {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

/** Color at horizontal position `t` ∈ [0,1] along the sunset gradient. */
export function sunsetColorAt(t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const segments = SUNSET_STOPS.length - 1;
  const scaled = clamped * segments;
  const idx = Math.min(segments - 1, Math.floor(scaled));
  const local = scaled - idx;
  const from = SUNSET_STOPS[idx] ?? SUNSET_STOPS[0];
  const to = SUNSET_STOPS[idx + 1] ?? from;
  const mix = (i: number): number =>
    Math.round(
      hexChannel(from, i) + (hexChannel(to, i) - hexChannel(from, i)) * local,
    );
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Split one wordmark row into runs of same-colored characters, coloring each
 * column by its position along the gradient. Adjacent columns that resolve to
 * the same hex merge into one run so the element count stays small.
 */
function gradientRuns(
  line: string,
  width: number,
): Array<{ text: string; color: string }> {
  const runs: Array<{ text: string; color: string }> = [];
  let text = "";
  let color = "";
  for (let i = 0; i < line.length; i++) {
    const c = sunsetColorAt(width <= 1 ? 0 : i / (width - 1));
    if (c === color) {
      text += line[i];
    } else {
      if (text) runs.push({ text, color });
      text = line[i] ?? "";
      color = c;
    }
  }
  if (text) runs.push({ text, color });
  return runs;
}

/** ms between each revealed row of the wordmark during the intro animation. */
const REVEAL_INTERVAL_MS = 70;

/**
 * Rows the Banner occupies (wordmark + bottom margin) — used by the
 * full-screen REPL layout to budget its fixed chrome. Kept next to the
 * component so the two can't drift apart.
 */
export function bannerRowCount(): number {
  return WORDMARK.length + 1;
}

/**
 * The Oxagen ASCII banner, used as the REPL header — always shown when the
 * app opens and persisted for the whole session (in scrollback in inline
 * mode, pinned at the top of the frame in full-screen mode), the same way
 * Claude Code keeps its header on screen.
 *
 * Renders ONLY the block OXAGEN wordmark in an amber→burnt-red sunset
 * gradient — deliberately no text lines beneath it. The CLI version (build
 * number) and the connected org/workspace scope live in the full-screen
 * HeaderBar, and the cwd in the REPO dock under the prompt; repeating any of
 * them here would be duplicate chrome.
 *
 * When `animate` is set the rows reveal top-to-bottom on mount; when unset it
 * draws fully immediately. The row count is fixed either way, so the layout
 * never jumps — unrevealed rows render as blank lines of the same width.
 */
export const Banner = React.memo(function Banner({
  animate = false,
}: {
  animate?: boolean;
}): React.ReactElement {
  const { cols } = useTerminalSize();
  const mark =
    cols !== undefined && cols < WORDMARK_FULL_WIDTH + 2
      ? cols < WORDMARK_WIDTH + 2
        ? []
        : WORDMARK
      : WORDMARK_FULL;
  const [revealed, setRevealed] = useState(animate ? 0 : mark.length);

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      setRevealed((n) => {
        if (n >= mark.length) {
          clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, REVEAL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [animate, mark.length]);

  const width = mark[0]?.length ?? 0;

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {WORDMARK.map((line, i) => (
        <Text key={i} bold>
          {i < revealed
            ? gradientRuns(line, width).map((run, j) => (
                <Text key={j} color={run.color} bold>
                  {run.text}
                </Text>
              ))
            : " ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
});
