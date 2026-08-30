/**
 * Local typings for marked-terminal v7 — the published @types/marked-terminal
 * package (6.1.1) targets marked <12 and predates the `markedTerminal`
 * extension helper, so we declare the small surface we actually use here.
 */
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  /** Styling hooks accepted by marked-terminal (chalk-style string transforms). */
  export interface TerminalRendererOptions {
    code?: (s: string) => string;
    blockquote?: (s: string) => string;
    html?: (s: string) => string;
    heading?: (s: string) => string;
    firstHeading?: (s: string) => string;
    hr?: (s: string) => string;
    listitem?: (s: string) => string;
    paragraph?: (s: string) => string;
    strong?: (s: string) => string;
    em?: (s: string) => string;
    codespan?: (s: string) => string;
    del?: (s: string) => string;
    link?: (s: string) => string;
    href?: (s: string) => string;
    /** Reflow text to `width` columns. Default false. */
    reflowText?: boolean;
    width?: number;
    /** Show hyperlink targets inline. Default false. */
    showSectionPrefix?: boolean;
    unescape?: boolean;
    emoji?: boolean;
    tableOptions?: Record<string, unknown>;
    tab?: number;
  }

  /**
   * marked v5+ extension: `new Marked(markedTerminal(options))` renders
   * markdown to an ANSI-styled terminal string.
   */
  export function markedTerminal(
    options?: TerminalRendererOptions,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;

  /** Legacy renderer class (marked <12 `setOptions({ renderer })` path). */
  export default class TerminalRenderer {
    constructor(
      options?: TerminalRendererOptions,
      highlightOptions?: Record<string, unknown>,
    );
  }
}
