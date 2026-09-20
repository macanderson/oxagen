"use client";
// A source editor: a textarea over a painted copy of its text. The textarea
// owns the caret, the selection and every key; the copy beneath it carries the
// syntax colours, and the two share one font, size, line height and padding
// so each glyph sits exactly over its coloured twin. The grid cell takes its
// width from the copy, so a long line widens the cell and the wrapper
// scrolls both layers as one, and the textarea never scrolls on its own.
// Pinned to the wrapper's width instead, the copy overflowed the cell while
// the textarea scrolled inside it, and the caret drifted off its glyph on
// any line wider than the viewport. Monaspace Neon
// (`--font-mono`) sets both, with texture healing on, and the ground is the
// code surface (`--code-bg`): a shade off the panel in either theme.
import { type ReactNode, useMemo } from "react";
import {
  type TomlToken,
  type TomlTokenKind,
  tokenizeToml,
} from "@/shared/toml-highlight";

export type CodeLanguage = "toml";

/** The scanner for each language the product edits; TOML is the one today. */
const SCANNERS: Record<CodeLanguage, (source: string) => TomlToken[]> = {
  toml: tokenizeToml,
};

const TOKEN_CLASS: Record<TomlTokenKind, string | null> = {
  comment: "text-code-comment",
  table: "font-medium text-code-table",
  key: "text-code-key",
  string: "text-code-string",
  number: "text-code-number",
  boolean: "text-code-number",
  punct: "text-code-punct",
  text: null,
};

/** The source as coloured spans; text outside a token is rendered as is. */
function highlight(source: string, language: CodeLanguage): ReactNode[] {
  const tokens = SCANNERS[language](source);
  const painted: ReactNode[] = [];
  // A token's offset in the source is its identity; no two share one.
  let offset = 0;
  for (const token of tokens) {
    const className = TOKEN_CLASS[token.kind];
    painted.push(
      className === null ? (
        token.text
      ) : (
        <span key={offset} className={className}>
          {token.text}
        </span>
      ),
    );
    offset += token.text.length;
  }
  return painted;
}

/** The one type scale for code: the class every code surface shares so an editor and a read-only block set alike. */
const codeText =
  "font-mono text-[13px] leading-5 [font-feature-settings:var(--ox-font-mono-features)]";

export function CodeEditor({
  value,
  onChange,
  language,
  label,
  minRows = 16,
}: {
  value: string;
  onChange: (next: string) => void;
  language: CodeLanguage;
  /** The accessible name of the textarea. */
  label: string;
  minRows?: number;
}) {
  const painted = useMemo(() => highlight(value, language), [value, language]);
  const lines = value.split("\n").length;
  return (
    <div
      data-testid="code-editor"
      className={`${codeText} flex min-h-80 overflow-auto rounded-md bg-code-bg p-4 text-foreground`}
    >
      <pre
        aria-hidden="true"
        className="m-0 select-none pr-4 text-right text-code-comment"
      >
        {Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n")}
      </pre>
      <div className="relative grid min-w-max flex-1">
        <pre
          aria-hidden="true"
          data-testid="code-paint"
          className="pointer-events-none m-0 whitespace-pre pr-6 [grid-area:1/1]"
        >
          {painted}
          {"\n"}
        </pre>
        <textarea
          aria-label={label}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          rows={Math.max(lines, minRows)}
          wrap="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={`${codeText} m-0 h-full w-full resize-none overflow-hidden whitespace-pre bg-transparent p-0 text-transparent caret-foreground outline-none [grid-area:1/1] focus-visible:outline-2 focus-visible:outline-ring`}
        />
      </div>
    </div>
  );
}
