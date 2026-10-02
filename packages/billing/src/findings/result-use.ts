/**
 * result-use.ts — whether a later step quoted a large tool result, the
 * measure decision 7 of the spend plan sets for detector 5 (context carry).
 * No I/O: ../findings-result-use.ts reads the bodies on a `content_exact`
 * workspace and hands the verdicts to the pass as a {@link ResultUseRead}.
 *
 * A quote is a run of at least {@link MIN_QUOTE_CHARS} characters that the
 * result's text and a later step's text share. Each side is compared as its
 * string values (JSON keys and numbers are left out), with every run of
 * whitespace read as one space. A string that holds JSON, as an MCP tool's
 * text result often does, is read as the values inside it. A run that the
 * result's own call input also holds is not a quote: a result often echoes
 * its input, such as the path a read took, and a later call that names the
 * same path did not need the result to know it.
 *
 * A result is used when a later call's input or the agent's own text quotes
 * it. It is unused only when every later step on its chain read back, none
 * quoted it, and the chain holds some text the agent wrote after it. Anything
 * less is no verdict, and detector 5 counts the result in full, as an upper
 * bound.
 */

/**
 * What the workspace keeps. `content_exact` keeps the text a quote is
 * checked in. `digest_only` keeps digests alone, so no result gets a verdict.
 */
export type ResultTextMode = "content_exact" | "digest_only";

/** A large result's verdict: a later step quoted it, or no later step did. */
export type ResultVerdict = "used" | "unused";

/** What the store read for detector 5's result use. */
export interface ResultUseRead {
  mode: ResultTextMode;
  /**
   * Each checked result's verdict, by {@link resultUseKey}. A result absent
   * here has no verdict: its text or a later step's did not read back, or
   * the read's budget passed its chain by.
   */
  verdicts: ReadonlyMap<string, ResultVerdict>;
}

/** The key a result's verdict is stored under: its run, its chain, and its position on the chain. */
export function resultUseKey(call: {
  runId: string;
  sessionUuid: string | null;
  seq: number;
}): string {
  return `${call.runId}|${call.sessionUuid ?? ""}|${call.seq}`;
}

/**
 * The shortest shared run of characters that counts as a quote. A line of
 * code, a file path with its directories, or a sentence passes it. JSON
 * scaffolding and a short id do not, so they cannot match by chance.
 */
export const MIN_QUOTE_CHARS = 40;

/**
 * A result is indexed by the windows of this length that start every
 * {@link WINDOW_STEP} characters. Any shared run of `MIN_QUOTE_CHARS`
 * characters holds one such window whole, so a scan of every window of the
 * later text finds it, and the match is then extended to its full length.
 */
const WINDOW = 32;
const WINDOW_STEP = MIN_QUOTE_CHARS - WINDOW + 1;

/** JSON inside a string is read this many levels deep. */
const NESTED_JSON_DEPTH = 3;

/** What separates a text's values, so no quote spans two of them. Each side uses its own. */
const RESULT_SEPARATOR = "\u0000";
const LATER_SEPARATOR = "\u0001";

function nestedJson(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The string values in a JSON value, depth first. A string that holds JSON gives the values inside it. */
export function textValues(value: unknown, depth = 0): string[] {
  if (typeof value === "string") {
    if (depth < NESTED_JSON_DEPTH) {
      const nested = nestedJson(value);
      if (nested !== undefined && nested !== null && typeof nested === "object")
        return textValues(nested, depth + 1);
    }
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((v) => textValues(v, depth));
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap((v) => textValues(v, depth));
  return [];
}

/** Values as one text: whitespace runs read as one space, joined by `separator`. */
function joined(values: readonly string[], separator: string): string {
  return values
    .map((v) =>
      v
        .split(RESULT_SEPARATOR)
        .join(" ")
        .split(LATER_SEPARATOR)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((v) => v.length > 0)
    .join(separator);
}

/** A large result, indexed for the quote search. */
export interface QuoteIndex {
  readonly text: string;
  /** The result's own call input, as the same kind of text. */
  readonly ownInput: string;
  /** Each window's first position in `text`. */
  readonly windows: ReadonlyMap<string, number>;
}

/**
 * The index of a result's values, or null when none of them is as long as a
 * quote: such a result cannot be quoted under this rule, so it gets no
 * verdict rather than an unused one.
 */
export function quoteIndex(
  resultValues: readonly string[],
  ownInputValues: readonly string[],
): QuoteIndex | null {
  const text = joined(resultValues, RESULT_SEPARATOR);
  if (!text.split(RESULT_SEPARATOR).some((v) => v.length >= MIN_QUOTE_CHARS))
    return null;
  const windows = new Map<string, number>();
  for (let p = 0; p + WINDOW <= text.length; p += WINDOW_STEP) {
    const w = text.slice(p, p + WINDOW);
    if (!windows.has(w)) windows.set(w, p);
  }
  return { text, ownInput: joined(ownInputValues, RESULT_SEPARATOR), windows };
}

/** Whether `laterValues` quote the indexed result. */
export function quotes(
  index: QuoteIndex,
  laterValues: readonly string[],
): boolean {
  const later = joined(laterValues, LATER_SEPARATOR);
  const { text } = index;
  for (let i = 0; i + WINDOW <= later.length; i += 1) {
    const p = index.windows.get(later.slice(i, i + WINDOW));
    if (p === undefined) continue;
    let before = 0;
    while (
      p - before > 0 &&
      i - before > 0 &&
      text[p - before - 1] === later[i - before - 1]
    )
      before += 1;
    let after = WINDOW;
    while (
      p + after < text.length &&
      i + after < later.length &&
      text[p + after] === later[i + after]
    )
      after += 1;
    if (before + after < MIN_QUOTE_CHARS) continue;
    const quote = later.slice(i - before, i + after);
    if (!index.ownInput.includes(quote)) return true;
    // The whole shared run is the result echoing its own input. Skip past it.
    i += after - WINDOW;
  }
  return false;
}

/**
 * One frame on a chain, as the result use read sees it: a tool call's body
 * (`{"input":…,"output":…}`), or text the agent wrote.
 */
export interface ChainFrame {
  /** Microseconds since the epoch, from the store's own text. */
  atMicros: number;
  seq: number;
  kind: "call" | "output";
  /** The body as UTF-8 text; null when it did not read back. */
  body: string | null;
  /** Set on a large result's own call: the key its verdict is stored under. */
  resultKey?: string;
}

interface OpenResult {
  key: string;
  index: QuoteIndex;
  used: boolean;
  /** A later step's body did not read back, so no quote can be ruled out. */
  gap: boolean;
  /** The chain holds text the agent wrote after the result. */
  sawOutput: boolean;
}

/** A call body's input and output values; null when the body is not a JSON object. */
function callValues(
  body: string,
): { input: string[]; output: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const o = parsed as Record<string, unknown>;
  return { input: textValues(o["input"]), output: textValues(o["output"]) };
}

/** What a later step contributes to the search: its call's input, or the agent's text. */
function laterValues(frame: ChainFrame): string[] | null {
  if (frame.body === null) return null;
  if (frame.kind === "output") return [frame.body];
  return callValues(frame.body)?.input ?? null;
}

/**
 * The verdict of each large result on one chain. A result is checked against
 * every frame after it, by time and then by position on the chain.
 */
export function chainVerdicts(
  frames: readonly ChainFrame[],
): Map<string, ResultVerdict> {
  const ordered = [...frames].sort(
    (a, b) => a.atMicros - b.atMicros || a.seq - b.seq,
  );
  const open: OpenResult[] = [];
  for (const frame of ordered) {
    const later = open.some((r) => !r.used) ? laterValues(frame) : null;
    for (const r of open) {
      if (frame.kind === "output") r.sawOutput = true;
      if (r.used) continue;
      if (frame.body === null || later === null) r.gap = true;
      else if (quotes(r.index, later)) r.used = true;
    }
    if (frame.resultKey === undefined || frame.body === null) continue;
    const values = callValues(frame.body);
    const index =
      values === null ? null : quoteIndex(values.output, values.input);
    if (index !== null)
      open.push({
        key: frame.resultKey,
        index,
        used: false,
        gap: false,
        sawOutput: false,
      });
  }
  const out = new Map<string, ResultVerdict>();
  for (const r of open) {
    if (r.used) out.set(r.key, "used");
    else if (!r.gap && r.sawOutput) out.set(r.key, "unused");
  }
  return out;
}
