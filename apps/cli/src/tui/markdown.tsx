import { Text } from "ink";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import React, { useMemo } from "react";

/**
 * Markdown rendering for Ink, after cameronhunter/ink-markdown.
 *
 * We vendor the (10-line) pattern rather than depend on the package: as of
 * ink-markdown@1.0.4 its build is CommonJS and `require`s ink — ink 7 is ESM
 * with top-level await, so loading it throws ERR_REQUIRE_ASYNC_MODULE at
 * runtime. Same approach, though: marked parses the markdown, marked-terminal
 * renders it to an ANSI-styled string, and Ink prints it inside a <Text>.
 *
 * Unlike ink-markdown we use a private `Marked` instance instead of mutating
 * marked's global options, so no other marked user in the process is affected.
 */
const terminalMarked = new Marked(
  markedTerminal({
    // Ink's <Text wrap="wrap"> already wraps to the terminal; letting
    // marked-terminal reflow too would fight it with hard line breaks.
    reflowText: false,
    emoji: true,
    // Keep heading chrome minimal — the REPL transcript is dense enough.
    showSectionPrefix: false,
  }),
);

/**
 * Render a markdown string as ANSI-styled terminal text: bold/italic emphasis,
 * cyan inline code, syntax-highlighted fenced code blocks, lists, quotes,
 * headings, links. Parsing is memoized on the source string, so committed
 * transcript messages (rendered once via <Static>) pay the parse exactly once.
 */
export function Markdown({
  children,
}: {
  children: string;
}): React.ReactElement {
  const rendered = useMemo(() => {
    try {
      return terminalMarked.parse(children, { async: false }).trimEnd();
    } catch {
      // Malformed markdown must never take down the transcript — fall back to
      // the raw text, which is exactly what the CLI rendered before this
      // component existed.
      return children;
    }
  }, [children]);
  return <Text wrap="wrap">{rendered}</Text>;
}
