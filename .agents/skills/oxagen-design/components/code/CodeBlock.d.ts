import * as React from "react";

/**
 * Single source-code listing with a header (language glyph + filename) and a
 * copy button. Mono face (this is literally code). Lightweight jewel-tone
 * syntax highlighting via the built-in tokenizer.
 *
 * @startingPoint section="Code" subtitle="Source code block with copy" viewport="700x220"
 */
export interface CodeBlockProps {
  code: string;
  /** Language key (drives the glyph + filename fallback), e.g. "ts", "py". */
  language?: string;
  filename?: string;
  showLineNumbers?: boolean;
  copy?: boolean;
  style?: React.CSSProperties;
}

export function CodeBlock(props: CodeBlockProps): React.ReactElement;
export interface CopyButtonProps { getText: () => string; }
export function CopyButton(props: CopyButtonProps): React.ReactElement;
