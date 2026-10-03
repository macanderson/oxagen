"use client";
// Read-only code in the house colours: a plain block, the surface a tool's
// worked example is shown on.
//
// Its ground is `--code-bg` and its token colours are the house's. Nothing
// here is themed
// by a highlighter of its own: the colours are the six `--code-*` tokens the
// house defines, which is what keeps a code block inside the brand in both
// light and dark rather than carrying a vendor's palette into it.

import { Fragment, type ReactNode } from "react";
import {
  type CodeLanguage,
  type CodeTokenKind,
  tokenizeCode,
} from "@/shared/code-highlight";

/** The one type scale for code. */
const codeText =
  "font-mono text-[12px] leading-[1.55] [font-feature-settings:var(--ox-font-mono-features)]";

const TOKEN_CLASS: Readonly<Record<CodeTokenKind, string | null>> = {
  comment: "text-code-comment",
  table: "font-medium text-code-table",
  key: "text-code-key",
  string: "text-code-string",
  number: "text-code-number",
  boolean: "text-code-number",
  punct: "text-code-punct",
  text: null,
};

/** One line as coloured spans. */
function paint(line: string, language: CodeLanguage): ReactNode[] {
  const tokens = tokenizeCode(line, language);
  let offset = 0;
  return tokens.map((token) => {
    const className = TOKEN_CLASS[token.kind];
    const key = offset;
    offset += token.text.length;
    if (className === null) return token.text;
    return (
      <span key={key} className={className}>
        {token.text}
      </span>
    );
  });
}

/**
 * Code as written, in the house colours, with no gutter: a worked example or
 * a payload a reader copies rather than reviews. Long lines wrap, because a
 * block inside a dialog that scrolls sideways hides the end of every line.
 */
export function CodeBlock({
  code,
  language = "text",
  label,
}: {
  code: string;
  language?: CodeLanguage;
  /**
   * What the block holds, for a screen reader. A `pre` has no role that may
   * carry a name, so a labelled block is a group.
   */
  label?: string;
}) {
  // Each line keyed by where it starts in the code, which never repeats.
  const lines: { start: number; text: string }[] = [];
  let start = 0;
  for (const text of code.split("\n")) {
    lines.push({ start, text });
    start += text.length + 1;
  }
  return (
    <pre
      data-code-block=""
      role={label === undefined ? undefined : "group"}
      aria-label={label}
      className={`${codeText} whitespace-pre-wrap break-words rounded-md border border-border bg-code-bg px-3 py-2.5 text-foreground`}
    >
      <code>
        {lines.map((line) => (
          <Fragment key={line.start}>
            {line.start === 0 ? null : "\n"}
            {paint(line.text, language)}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}
