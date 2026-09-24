"use client";
// A read-only diff, with line numbers and the house code colours: the surface
// the agent source editor shows a proposed change on.
//
// It shares its type scale, its ground (`--code-bg`) and its token colours
// with `code-editor.tsx`, so a change a reader reviews here and the file they
// edit beside it are visibly the same kind of thing. Nothing here is themed
// by a highlighter of its own: the colours are the six `--code-*` tokens the
// house defines, which is what keeps a code block inside the brand in both
// light and dark rather than carrying a vendor's palette into it.

import type { ReactNode } from "react";
import {
  type CodeLanguage,
  type CodeTokenKind,
  tokenizeCode,
} from "@/shared/code-highlight";
import type { DiffLine, LineDiff } from "@/shared/line-diff";

/** The one type scale for code, shared with `code-editor.tsx`. */
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

const gutter = "select-none pr-3 text-right tabular-nums text-code-comment/70";

const OP_ROW: Readonly<Record<DiffLine["op"], string>> = {
  add: "bg-success/10",
  del: "bg-destructive/10",
  ctx: "",
};
const OP_MARK: Readonly<Record<DiffLine["op"], string>> = {
  add: "text-success",
  del: "text-destructive",
  ctx: "text-code-comment/70",
};
const OP_SIGN: Readonly<Record<DiffLine["op"], string>> = {
  add: "+",
  del: "−",
  ctx: " ",
};

/**
 * A change as a diff: the old line numbers, the new ones, and the sign.
 *
 * Both gutters are drawn rather than one, because "which line of the file
 * this is now" and "which line it was" are different questions and an edit
 * that moved a block makes them different answers. The sign is drawn as well
 * as the tint, so the diff survives greyscale and colour blindness, which a
 * red/green wash alone does not.
 */
export function DiffPanel({
  diff,
  path,
  language = "text",
  label,
}: {
  diff: LineDiff;
  path: string;
  language?: CodeLanguage;
  label: string;
}) {
  const stat = `+${String(diff.added)} −${String(diff.removed)}`;
  return (
    <div
      data-testid="diff-panel"
      className="overflow-hidden rounded-md border border-border bg-code-bg"
    >
      <div className="flex flex-wrap items-baseline gap-2 border-b border-border px-2.5 py-1">
        <span className="font-mono text-[11px] text-foreground">{path}</span>
        <span className="ml-auto font-mono text-[10.5px] tabular-nums">
          <span className="text-success">+{diff.added}</span>{" "}
          <span className="text-destructive">−{diff.removed}</span>
        </span>
      </div>
      <div className={`${codeText} overflow-x-auto`}>
        {diff.hunks.map((hunk) => (
          <table
            key={`${String(hunk.beforeStart)}-${String(hunk.afterStart)}`}
            className="w-full border-collapse border-t border-border first:border-t-0"
          >
            <tbody>
              {hunk.lines.map((line) => (
                <tr
                  key={`${line.op}-${String(line.before ?? "n")}-${String(line.after ?? "n")}`}
                  className={OP_ROW[line.op]}
                >
                  <td className={`${gutter} w-px pl-2.5 align-top`}>
                    {line.before ?? ""}
                  </td>
                  <td className={`${gutter} w-px align-top`}>
                    {line.after ?? ""}
                  </td>
                  <td
                    aria-hidden="true"
                    className={`w-px select-none pr-2 align-top ${OP_MARK[line.op]}`}
                  >
                    {OP_SIGN[line.op]}
                  </td>
                  <td className="whitespace-pre-wrap break-words pr-2.5 align-top text-foreground">
                    {line.text === "" ? " " : paint(line.text, language)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
      <div className="sr-only">{`${label}: ${path}, ${stat}`}</div>
    </div>
  );
}
