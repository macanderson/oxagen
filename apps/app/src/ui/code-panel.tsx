"use client";
// Read-only source, with line numbers and the house code colours: the surface
// a transcript shows a command, a file's contents or a diff on.
//
// It shares its type scale, its ground (`--code-bg`) and its token colours
// with `code-editor.tsx`, so a command a reader sees here and a file they
// edit elsewhere are visibly the same kind of thing. Nothing here is themed
// by a highlighter of its own: the colours are the six `--code-*` tokens the
// house defines, which is what keeps a code block inside the brand in both
// light and dark rather than carrying a vendor's palette into it.
//
// Long content is shown to a line budget and unfolded by the reader. The
// budget is a property of the pane, not of this component, because how much
// of a thing is worth seeing unprompted depends on what it is: a file that
// was just created is worth twenty lines, a command's output five.

import { type ReactNode, useId, useMemo, useState } from "react";
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

/** The control that unfolds a pane, and says how much is still folded. */
function More({
  hidden,
  open,
  onToggle,
  controls,
  label,
}: {
  hidden: number;
  open: boolean;
  onToggle: () => void;
  controls: string;
  label: string;
}) {
  return (
    <button
      type="button"
      data-testid="code-panel-more"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 border-t border-border px-2.5 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <span
        aria-hidden="true"
        className={`inline-block text-[8px] transition-transform ${open ? "rotate-90" : ""}`}
      >
        ▶
      </span>
      {open ? label : `${label} (${String(hidden)} more)`}
    </button>
  );
}

/**
 * Source with line numbers.
 *
 * `preview` is how many lines open unfolded; null opens all of them. A pane
 * whose content fits the budget draws no control at all, so a one-line
 * command has nothing to click — which is the whole point of passing the
 * budget in rather than fixing it here.
 */
export function CodePanel({
  code,
  language = "text",
  startLine = 1,
  preview = null,
  label,
  expandLabel,
}: {
  code: string;
  language?: CodeLanguage;
  startLine?: number;
  preview?: number | null;
  /** The heading above the panel; omitted when the pane needs no name. */
  label?: string;
  /** What the unfold control says. */
  expandLabel: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  // Trailing newline: a file ending in one is not a file with a blank last
  // line, and numbering it as one would be wrong.
  const lines = useMemo(() => code.replace(/\n$/, "").split("\n"), [code]);
  const budget = preview ?? lines.length;
  const folded = !open && lines.length > budget;
  const shown = folded ? lines.slice(0, budget) : lines;
  const width = String(startLine + lines.length - 1).length;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-code-bg">
      {label === undefined ? null : (
        <div className="border-b border-border px-2.5 py-1 font-mono text-[10.5px] tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </div>
      )}
      <div id={id} className={`${codeText} overflow-x-auto p-2.5`}>
        <table className="w-full border-collapse">
          <tbody>
            {shown.map((line, index) => (
              // Source lines repeat (blank lines, duplicate statements), so
              // the line number is the only candidate key and it is derived
              // from the row index.
              // eslint-disable-next-line @eslint-react/no-array-index-key -- line number is the natural key and always derives from the row index
              <tr key={startLine + index}>
                <td
                  className={`${gutter} w-px align-top`}
                  style={{ minWidth: `${String(width)}ch` }}
                >
                  {startLine + index}
                </td>
                <td className="whitespace-pre-wrap break-words align-top text-foreground">
                  {line === "" ? " " : paint(line, language)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length > budget ? (
        <More
          hidden={lines.length - budget}
          open={open}
          onToggle={() => {
            setOpen((was) => !was);
          }}
          controls={id}
          label={expandLabel}
        />
      ) : null}
    </div>
  );
}

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
        {diff.hunks.map((hunk, index) => (
          <table
            key={`${String(hunk.beforeStart)}-${String(hunk.afterStart)}-${String(index)}`}
            className="w-full border-collapse border-t border-border first:border-t-0"
          >
            <tbody>
              {hunk.lines.map((line, row) => (
                <tr
                  key={`${line.op}-${String(line.before ?? "n")}-${String(line.after ?? "n")}-${String(row)}`}
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
