/**
 * The one line a step card leads with, and the figures beside it
 * (Mission Control spec §14).
 *
 * `summarizeStep` is a pure function of the blocks a frame folded into, the
 * usage the provider reported and what the recorder timed. Same frame in,
 * same line out: there is no second model call here and there must never be
 * one. A precis that changed between two reads of the same sealed run would
 * be a summary of the summariser, not of the run, and the record is the
 * thing a person is here to read.
 *
 * The precis is built by template from the block kinds, so it says what the
 * agent DID rather than quoting what it said it would do: the first sentence
 * of the first text block, its first-person lead-in dropped and its verb put
 * in the past, then the tools it asked for.
 *
 *     "I'll write the filing plan."  + Write, Bash
 *     -> "Wrote the filing plan, then asked for Write and Bash."
 */
import type { AssemblyUsage, ContentBlock } from "./content-blocks";

/** The longest a precis runs. Past it the line wraps and stops being one line. */
export const PRECIS_MAX = 90;

export interface StepTiming {
  ttftMs: number | null;
  durationMs: number | null;
}

/** What one block cost, and what it is made of. */
export interface BlockFigure {
  id: string;
  kind: ContentBlock["kind"];
  tokens: number;
  chars: number;
  /**
   * The block's share of the step's output spend, micro-USD; null when the
   * price book priced no output for this model. A share nobody can price is
   * left out rather than drawn as a zero.
   */
  costMicros: number | null;
}

export interface StepSummary {
  precis: string;
  /** Output tokens per second of wall time; null without both figures. */
  tokensPerSecond: number | null;
  ttftMs: number | null;
  durationMs: number | null;
  blocks: BlockFigure[];
}

/**
 * Lead-ins a model opens with before saying what it is about to do. Dropping
 * one leaves a bare verb phrase, which is what the past-tense rule needs.
 * Ordered longest first so the longest match wins.
 */
const LEAD_INS = [
  "next, i am going to ",
  "next, i'm going to ",
  "now i am going to ",
  "now i'm going to ",
  "i am going to ",
  "i'm going to ",
  "next, i will ",
  "next, i'll ",
  "now i will ",
  "now i'll ",
  "let me go ahead and ",
  "let me first ",
  "let me ",
  "i will now ",
  "i'll now ",
  "i will ",
  "i'll ",
  "i am ",
  "i'm ",
  "first, ",
  "next, ",
  "now, ",
  "okay, ",
  "sure, ",
  "alright, ",
] as const;

/**
 * Verbs whose past tense is not the regular rule. Small on purpose: this is
 * the set a coding agent actually opens a sentence with. A verb that is not
 * here takes the regular rule below, and a word the rule cannot read is left
 * as it was rather than mangled.
 */
const IRREGULAR: Readonly<Record<string, string>> = {
  be: "was",
  begin: "began",
  bring: "brought",
  build: "built",
  buy: "bought",
  catch: "caught",
  choose: "chose",
  come: "came",
  cut: "cut",
  do: "did",
  draw: "drew",
  drop: "dropped",
  fall: "fell",
  feed: "fed",
  find: "found",
  get: "got",
  give: "gave",
  go: "went",
  grep: "grepped",
  hold: "held",
  keep: "kept",
  know: "knew",
  leave: "left",
  let: "let",
  make: "made",
  put: "put",
  read: "read",
  rebuild: "rebuilt",
  run: "ran",
  say: "said",
  see: "saw",
  seek: "sought",
  send: "sent",
  set: "set",
  sit: "sat",
  split: "split",
  spend: "spent",
  stand: "stood",
  swap: "swapped",
  take: "took",
  teach: "taught",
  tell: "told",
  think: "thought",
  understand: "understood",
  write: "wrote",
};

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
/** Consonants a short verb doubles before `-ed` (`drop` -> `dropped`). */
const DOUBLES = new Set(["b", "d", "g", "l", "m", "n", "p", "r", "t"]);

/** A bare verb in the past tense. Regular unless {@link IRREGULAR} says not. */
export function pastTense(verb: string): string {
  const lower = verb.toLowerCase();
  const irregular = IRREGULAR[lower];
  if (irregular !== undefined) return irregular;
  if (!/^[a-z]+$/.test(lower)) return verb;
  if (lower.endsWith("ed")) return lower;
  if (lower.endsWith("e")) return `${lower}d`;
  if (lower.endsWith("y") && !VOWELS.has(lower.slice(-2, -1))) {
    return `${lower.slice(0, -1)}ied`;
  }
  const last = lower.slice(-1);
  const before = lower.slice(-2, -1);
  const third = lower.slice(-3, -2);
  // One syllable, consonant-vowel-consonant: double the consonant.
  if (
    lower.length <= 5 &&
    DOUBLES.has(last) &&
    VOWELS.has(before) &&
    third !== "" &&
    !VOWELS.has(third)
  ) {
    return `${lower}${last}ed`;
  }
  return `${lower}ed`;
}

/** The first sentence of `text`, or null when there is nothing to take. */
function firstSentence(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // A fenced block or a list opener is not a sentence about what was done.
  if (trimmed.startsWith("```") || /^[-*#>|]/.test(trimmed)) return null;
  const match = /^[\s\S]*?[.!?](\s|$)/.exec(trimmed);
  const sentence = (match === null ? trimmed : match[0]).trim();
  return sentence === "" ? null : sentence;
}

function dropLeadIn(sentence: string): string {
  const lower = sentence.toLowerCase();
  for (const lead of LEAD_INS) {
    if (lower.startsWith(lead)) return sentence.slice(lead.length);
  }
  return sentence;
}

/** The sentence as a past-tense clause: `write the plan` -> `Wrote the plan`. */
export function clauseOf(sentence: string): string | null {
  const body = dropLeadIn(sentence).replace(/[.!?]+$/, "").trim();
  if (body === "") return null;
  const space = body.indexOf(" ");
  const head = space === -1 ? body : body.slice(0, space);
  const rest = space === -1 ? "" : body.slice(space);
  if (!/^[A-Za-z']+$/.test(head)) return null;
  const past = pastTense(head);
  return `${past.slice(0, 1).toUpperCase()}${past.slice(1)}${rest}`;
}

/** `Write`, `Write and Bash`, `Write, Bash and Read`. */
export function nameList(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] as string}`;
}

/** Clamp on a word boundary, never mid-word. */
function clamp(line: string, max: number): string {
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,\s]+$/, "")}…`;
}

function linesOf(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split("\n").length;
}

/**
 * The step's one line. Built from the block kinds and nothing else, so a
 * sealed run reads the same way on every read.
 */
export function precisOf(blocks: readonly ContentBlock[]): string {
  const text = blocks.filter((b): b is Extract<ContentBlock, { kind: "text" }> =>
    b.kind === "text",
  );
  const tools = blocks.filter(
    (b): b is Extract<ContentBlock, { kind: "tool_use" }> => b.kind === "tool_use",
  );
  const toolNames = [...new Set(tools.map((b) => b.name))];
  const asked =
    toolNames.length === 0 ? null : `asked for ${nameList(toolNames)}`;

  const sentence = text
    .map((block) => firstSentence(block.text))
    .find((s): s is string => s !== null);
  const clause = sentence === undefined ? null : clauseOf(sentence);

  if (clause !== null) {
    return clamp(asked === null ? `${clause}.` : `${clause}, then ${asked}.`, PRECIS_MAX);
  }
  const lines = text.reduce((sum, block) => sum + linesOf(block.text), 0);
  if (lines > 0) {
    const wrote = `Wrote ${lines} ${lines === 1 ? "line" : "lines"}`;
    return clamp(asked === null ? `${wrote}.` : `${wrote}, then ${asked}.`, PRECIS_MAX);
  }
  if (asked !== null) {
    return clamp(`${asked.slice(0, 1).toUpperCase()}${asked.slice(1)}.`, PRECIS_MAX);
  }
  const thought = blocks.filter((b) => b.kind === "thinking").length;
  if (thought > 0) return "Thought, and said nothing.";
  return "Returned no content.";
}

/** Micro-USD for `tokens` at `microsPerMillion`, rounded once. */
function priceTokens(tokens: number, microsPerMillion: number | null): number | null {
  if (microsPerMillion === null) return null;
  return Math.round((tokens * microsPerMillion) / 1_000_000);
}

/**
 * The step's summary line and figures.
 *
 * `outputMicrosPerMillion` is the model's output rate from the price book;
 * null when the book priced no output for this model, and then no block
 * carries a cost.
 */
export function summarizeStep(
  blocks: readonly ContentBlock[],
  usage: AssemblyUsage,
  timing: StepTiming,
  outputMicrosPerMillion: number | null = null,
): StepSummary {
  const seconds =
    timing.durationMs === null || timing.durationMs <= 0
      ? null
      : timing.durationMs / 1000;
  const output = usage.outputTokens;
  return {
    precis: precisOf(blocks),
    tokensPerSecond:
      seconds === null || output === null
        ? null
        : Math.round((output / seconds) * 10) / 10,
    ttftMs: timing.ttftMs,
    durationMs: timing.durationMs,
    blocks: blocks.map((block) => ({
      id: block.id,
      kind: block.kind,
      tokens: block.tokens,
      chars: block.chars,
      costMicros: priceTokens(block.tokens, outputMicrosPerMillion),
    })),
  };
}
