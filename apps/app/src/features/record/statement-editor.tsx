"use client";
// The statement editor (#3395; mockups/pages/record.md, the mockup's shared
// editor `cedHtml`): a textarea over three painted layers of the same text. The
// textarea owns the caret, the selection and every key. Beneath it sit the
// syntax paint, the find marks and the current-line band, and beside it the
// line-number gutter. A statement is prose, so the editor wraps, and wrapping
// means one logical line can be several visual lines: each line is its own
// block in every layer, and the gutter number takes the height of the painted
// block it numbers.
//
// The editor holds the statement and nothing else. The lineage, the kind, the
// force and the scope are the rest of the file, and each is changed the same
// way: a pull request. Widening this box to the whole file would let a reader
// change a record's kind in a field labelled "statement", which is the one
// edit the checks cannot catch as a mistake.
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mono, panel } from "@/ui/control-styles";
import { type MarkdownTokenKind, tokenizeMarkdown } from "./markdown";

const TOKEN_CLASS: Record<MarkdownTokenKind, string | null> = {
  heading: "font-medium text-code-table",
  quote: "text-code-comment",
  marker: "font-semibold text-code-number",
  code: "text-code-string",
  strong: "font-semibold text-code-number",
  fence: "text-code-comment",
  text: null,
};

/** `.ed-scroll { font-size:12.5px; line-height:var(--ed-lh) }`: 20px lines, 12px padding. */
const LINE = 20;
const PAD = 12;
const codeText =
  "font-mono text-[12.5px] leading-5 [font-feature-settings:var(--ox-font-mono-features)]";
const layer =
  "m-0 whitespace-pre-wrap break-words px-[18px] py-3 [overflow-wrap:break-word] [tab-size:2]";

/**
 * Ln and Col of an offset, 1-based, as the status line prints them.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function caretAt(
  value: string,
  index: number,
): { line: number; col: number } {
  const before = value.slice(0, index);
  const line = before.split("\n").length;
  return { line, col: before.length - before.lastIndexOf("\n") };
}

/**
 * Every case-insensitive match of `query` in `text`, as start offsets.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function findAll(text: string, query: string): number[] {
  if (query === "") return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return found;
    found.push(at);
    from = at + needle.length;
  }
}

/**
 * The edit Tab and Shift+Tab make: two spaces at the caret, or two spaces in
 * or out on every line of a multi-line selection. Returns the new text and
 * the selection to restore.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function indent(
  value: string,
  start: number,
  end: number,
  outdent: boolean,
): { value: string; start: number; end: number } {
  const multi = value.slice(start, end).includes("\n");
  if (!outdent && !multi) {
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    return { value: next, start: start + 2, end: start + 2 };
  }
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const stop = value.indexOf("\n", end);
  const to = stop < 0 ? value.length : stop;
  const block = value
    .slice(from, to)
    .split("\n")
    .map((line) => (outdent ? line.replace(/^ {1,2}/, "") : `  ${line}`))
    .join("\n");
  return {
    value: value.slice(0, from) + block + value.slice(to),
    start: from,
    end: from + block.length,
  };
}

/**
 * The edit Enter makes: a new line at the indent of the current one, and in a
 * list, the next marker (the next number after a numbered step).
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function newline(
  value: string,
  start: number,
  end: number,
): { value: string; start: number; end: number } {
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const current = value.slice(lineStart, start);
  let lead = /^\s*/.exec(current)?.[0] ?? "";
  const item = /^(\s*)([-*+]|\d+\.)\s/.exec(current);
  if (item?.[1] !== undefined && item[2] !== undefined) {
    const marker = /^\d/.test(item[2])
      ? `${String(Number.parseInt(item[2], 10) + 1)}.`
      : item[2];
    lead = `${item[1]}${marker} `;
  }
  const insert = `\n${lead}`;
  const next = value.slice(0, start) + insert + value.slice(end);
  const caret = start + insert.length;
  return { value: next, start: caret, end: caret };
}

export function StatementEditor({
  path,
  value,
  base,
  onChange,
  bar,
}: {
  /** `.oxagen/rules/<lineage>.toml · statement`. */
  path: string;
  value: string;
  /** The statement in force; the draft is modified when it differs. */
  base: string;
  onChange: (next: string) => void;
  /** What sits between the change state and the find box: the bundle tokens. */
  bar: ReactNode;
}) {
  const t = useTranslations("record.editor");
  const findId = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const paintRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<{ start: number; end: number } | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<number | null>(null);
  const [heights, setHeights] = useState<number[]>([]);
  const [band, setBand] = useState({ top: PAD, height: LINE });

  const lines = useMemo(() => value.split("\n"), [value]);
  const painted = useMemo(() => tokenizeMarkdown(value), [value]);
  const matches = useMemo(() => findAll(value, query), [value, query]);
  const dirty = value !== base;
  const caret = caretAt(value, selection.start);

  // A restored selection after an edit this component made, and the gutter's
  // heights and the band's place measured from the painted blocks. Both read
  // layout, so both run before paint.
  useLayoutEffect(() => {
    const pending = restoreRef.current;
    if (pending !== null && areaRef.current !== null) {
      areaRef.current.setSelectionRange(pending.start, pending.end);
      restoreRef.current = null;
    }
    const blocks = paintRef.current?.children;
    if (blocks === undefined) return;
    const measured = Array.from(blocks, (block) =>
      block instanceof HTMLElement ? block.offsetHeight || LINE : LINE,
    );
    // A measurement of the layout this render produced, so it can only be
    // stored after paint's layout exists; the updater returns the previous
    // array when nothing moved, which ends the pass.
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- layout measurement, see above
    setHeights((previous) =>
      previous.length === measured.length &&
      previous.every((height, i) => height === measured[i])
        ? previous
        : measured,
    );
    const row = blocks[caret.line - 1];
    const top = row instanceof HTMLElement ? PAD + row.offsetTop : PAD;
    const height = row instanceof HTMLElement ? row.offsetHeight || LINE : LINE;
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- layout measurement; the updater keeps the previous band when it did not move
    setBand((previous) =>
      previous.top === top && previous.height === height
        ? previous
        : { top, height },
    );
  }, [value, caret.line]);

  function track() {
    const node = areaRef.current;
    if (node === null) return;
    setSelection({ start: node.selectionStart, end: node.selectionEnd });
  }

  function apply(edit: { value: string; start: number; end: number }) {
    restoreRef.current = { start: edit.start, end: edit.end };
    setSelection({ start: edit.start, end: edit.end });
    setCurrent(null);
    onChange(edit.value);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const node = event.currentTarget;
    const start = node.selectionStart;
    const end = node.selectionEnd;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "f") {
      event.preventDefault();
      findRef.current?.focus();
      findRef.current?.select();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      apply(indent(value, start, end, event.shiftKey));
      return;
    }
    if (event.key === "Enter" && !modifier) {
      event.preventDefault();
      apply(newline(value, start, end));
      return;
    }
    if (event.key === "Escape" && query !== "") {
      event.stopPropagation();
      setQuery("");
      setCurrent(null);
    }
  }

  function step(direction: 1 | -1) {
    const node = areaRef.current;
    if (node === null || matches.length === 0) return;
    const from = direction > 0 ? node.selectionEnd : node.selectionStart - 1;
    const next =
      direction > 0
        ? (matches.find((at) => at >= from) ?? matches[0])
        : ([...matches].reverse().find((at) => at < from) ?? matches.at(-1));
    if (next === undefined) return;
    setCurrent(next);
    node.focus();
    node.setSelectionRange(next, next + query.length);
    setSelection({ start: next, end: next + query.length });
  }

  const index = current === null ? null : matches.indexOf(current) + 1;
  const found =
    query === ""
      ? ""
      : matches.length === 0
        ? "0"
        : index === null || index === 0
          ? String(matches.length)
          : t("matchOf", { index, count: matches.length });
  const selected = selection.end - selection.start;

  return (
    <section
      aria-label={path}
      data-testid="record-editor"
      className={`${panel} flex flex-col`}
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2 text-xs text-muted-foreground">
        <span className={`${mono} min-w-0 break-all text-foreground`}>
          {path}
        </span>
        <span
          aria-hidden="true"
          data-on={dirty ? "" : undefined}
          title={t("unsaved")}
          className="size-2 flex-none rounded-full border border-rule data-on:border-info data-on:bg-info"
        />
        <span data-testid="draft-state">
          {dirty ? t("modified") : t("unchanged")}
        </span>
        {bar}
        <span className="flex-1" />
        <label htmlFor={findId} className="flex items-center gap-1.5">
          <span className="sr-only">{t("findLabel")}</span>
          <input
            id={findId}
            ref={findRef}
            type="search"
            data-testid="record-find"
            value={query}
            placeholder={t("find")}
            onChange={(event) => {
              setQuery(event.target.value);
              setCurrent(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery("");
                setCurrent(null);
                areaRef.current?.focus();
              }
            }}
            className="w-[170px] max-w-full rounded-[7px] border border-border bg-input-bg px-2 py-1 font-mono text-base text-foreground outline-none focus-visible:border-input-border-focus sm:text-xs"
          />
          <span
            data-testid="record-find-count"
            aria-live="polite"
            className={`${mono} text-dim`}
          >
            {found}
          </span>
        </label>
      </div>
      <div
        className={`${codeText} grid max-h-[calc(100vh-300px)] min-h-[180px] grid-cols-[max-content_minmax(0,1fr)] overflow-auto bg-code-bg`}
      >
        <div
          aria-hidden="true"
          data-testid="record-gutter"
          className="sticky left-0 z-[4] min-w-11 select-none border-r border-border bg-code-bg py-3 pr-2.5 pl-3.5 text-right text-dim"
        >
          {lines.map((_, i) => (
            // eslint-disable-next-line @eslint-react/no-array-index-key -- the key is the line number, which is what this gutter row is
            <div key={i} style={{ height: heights[i] ?? LINE }}>
              {i + 1}
            </div>
          ))}
        </div>
        <div className="relative min-w-0">
          <div
            aria-hidden="true"
            data-testid="record-current-line"
            className="pointer-events-none absolute inset-x-0 z-0 bg-hl"
            style={{ top: band.top, height: band.height }}
          />
          <div
            ref={paintRef}
            aria-hidden="true"
            data-testid="record-paint"
            className={`${layer} pointer-events-none relative z-[2] text-foreground`}
          >
            {painted.map((tokens, i) => (
              // eslint-disable-next-line @eslint-react/no-array-index-key -- one painted block per source line, keyed by its line number like the gutter beside it
              <div key={i} className="min-h-5">
                {tokens.map((token, j) => {
                  const className = TOKEN_CLASS[token.kind];
                  return className === null ? (
                    token.text
                  ) : (
                    // eslint-disable-next-line @eslint-react/no-array-index-key -- a token's place in its line is its identity; the tokenizer re-derives the line whole on every edit
                    <span key={j} data-token={token.kind} className={className}>
                      {token.text}
                    </span>
                  );
                })}
                {"​"}
              </div>
            ))}
          </div>
          <div
            aria-hidden="true"
            className={`${layer} pointer-events-none absolute inset-0 z-[1] text-transparent`}
          >
            <Marks
              text={value}
              query={query}
              matches={matches}
              current={current}
            />
          </div>
          <textarea
            ref={areaRef}
            aria-label={path}
            data-testid="record-statement"
            value={value}
            wrap="soft"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            onChange={(event) => {
              setCurrent(null);
              onChange(event.target.value);
              setSelection({
                start: event.target.selectionStart,
                end: event.target.selectionEnd,
              });
            }}
            onSelect={track}
            onKeyUp={track}
            onClick={track}
            onKeyDown={keyDown}
            className={`${codeText} ${layer} absolute inset-0 z-[3] block size-full resize-none overflow-hidden border-0 bg-transparent text-base text-transparent caret-foreground outline-none [-webkit-text-fill-color:transparent] focus-visible:outline-2 focus-visible:outline-ring sm:text-[12.5px]`}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-3.5 border-t border-border px-3.5 py-1.5 text-[11px] text-muted-foreground">
        <span data-testid="record-caret">
          {t("caret", caret)}
          {selected > 0 ? ` ${t("selected", { count: selected })}` : ""}
        </span>
        <span data-testid="record-grammar">{t("grammar")}</span>
        <span data-testid="record-counts">
          {t("counts", { lines: lines.length, characters: value.length })}
        </span>
        <span>{t("lineEnding")}</span>
        <span>{t("encoding")}</span>
        <span className="flex-1" />
        <span className="hidden text-dim md:inline">{t("keys")}</span>
      </div>
    </section>
  );
}

/** The find layer: the text in transparent ink with each match marked. */
function Marks({
  text,
  query,
  matches,
  current,
}: {
  text: string;
  query: string;
  matches: number[];
  current: number | null;
}) {
  if (matches.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const at of matches) {
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <mark
        key={at}
        data-current={at === current ? "" : undefined}
        className="rounded-[2px] bg-gold/30 text-transparent data-current:bg-gold/55 data-current:outline data-current:outline-1 data-current:outline-gold"
      >
        {text.slice(at, at + query.length)}
      </mark>,
    );
    last = at + query.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
