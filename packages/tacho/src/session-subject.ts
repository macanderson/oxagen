/**
 * Short names for a session or a run, taken from the prompt that started it.
 *
 * A list of runs reads by name, the way a list of Claude Code sessions does:
 * "Fix conflicts on PR 123", not an id and not the first eighty characters of
 * whatever someone typed. Every function here is pure, so the run ingest, the
 * conversation writer, the enrichment job, and the browser all derive the
 * same name from the same prompt.
 */

/** The hard cap on a session name, counted in code points. */
export const SESSION_SUBJECT_MAX = 72;

/** A run summary keeps this many sentences at most. */
export const SUMMARY_MAX_SENTENCES = 3;

/** A run summary keeps this many code points at most. */
export const SUMMARY_MAX_CHARS = 400;

// The notes `run.enrich` ends an account with. They live beside
// `clipSummary`, so a view that cuts a long summary keeps them, and the
// writer and the view share one text (#4622).

/** The account's last sentence when the budget stopped the job early. */
export const ENRICHMENT_BUDGET_NOTE =
  " The account covers only the start of the run: its enrichment budget ran out before the rest was read.";

/** The account's sentence when its input reached a read limit. */
export const ENRICHMENT_LIMIT_NOTE =
  " The account covers only the start of the run because its transcript reached a read limit.";

const PARTIAL_NOTE_HEAD = "Evidence is partial: ";
const PARTIAL_NOTE_TAIL = " recorded bodies were unavailable.";

/** The account's sentence when some recorded bodies could not be read. */
export function partialEvidenceNote(missing: number): string {
  return missing > 0
    ? ` ${PARTIAL_NOTE_HEAD}${String(missing)}${PARTIAL_NOTE_TAIL}`
    : "";
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const NOTE_SOURCE = [
  `${escapeRegExp(PARTIAL_NOTE_HEAD)}\\d+${escapeRegExp(PARTIAL_NOTE_TAIL)}`,
  escapeRegExp(ENRICHMENT_BUDGET_NOTE.trim()),
  escapeRegExp(ENRICHMENT_LIMIT_NOTE.trim()),
].join("|");

/** One or more notes at the end of a collapsed summary. */
const TRAILING_NOTES = new RegExp(
  `(?:^|\\s)((?:${NOTE_SOURCE})(?:\\s(?:${NOTE_SOURCE}))*)$`,
  "u",
);

const GITHUB_REF_SOURCE =
  String.raw`\bhttps?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/(\d+)\S*`;

const githubRefs = (): RegExp => new RegExp(GITHUB_REF_SOURCE, "giu");

const HAS_WORD = /[\p{L}\p{N}]/u;

/** A trailing reference after one of these words reads inline: "fix it in PR 12". */
const PREPOSITION_TAIL = /\b(?:on|in|for|to|at|of|from|about|with)\s*$/iu;

const LEAD_IN =
  /^(?:(?:hey|hi|hello|ok|okay|so)(?:\s+(?:claude|there))?\b[\s,.!]*)?(?:(?:please|pls|kindly)\b[\s,]*|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need)\s+you\s+to\s+)?/iu;

const TRAILING_COURTESY = /(?:[\s,]+(?:please|thanks|thank you|for me))+[\s.!?]*$/iu;

const LIST_MARKER = /^(?:[-*>#]+\s+|\d+[.)]\s+)/u;

const TRAILING_PUNCT = /[\s.,;:!?…\-–—]+$/u;

const SENTENCE = /\S.*?(?:[.?!]+(?=\s|$)|$)/gu;

/** Words a cut can leave dangling at the end of a name. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/** A clause boundary is worth cutting at only when it keeps this much. */
const CLAUSE_MIN = 16;

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();

const refLabel = (kind: string, number: string): string =>
  `${kind.toLowerCase() === "pull" ? "PR" : "issue"} ${number}`;

function capitalize(text: string): string {
  const first = /^\S+/u.exec(text)?.[0] ?? "";
  // "iOS" and "pnpm-lock" stay as written: only an all-lowercase first word
  // takes a capital, so a proper name is never bent into sentence case.
  if (first !== first.toLowerCase()) return text;
  const [head = "", ...rest] = Array.from(text);
  return head.toUpperCase() + rest.join("");
}

function stripTail(text: string): string {
  return text.replace(TRAILING_PUNCT, "");
}

function stripDanglingWords(text: string): string {
  let out = stripTail(text);
  for (;;) {
    const last = /\s(\S+)$/u.exec(out);
    if (!last || !STOP_WORDS.has(last[1]!.toLowerCase())) return out;
    out = stripTail(out.slice(0, last.index));
  }
}

/**
 * Cuts `text` to at most `max` code points. A clause boundary wins over a
 * word boundary, and a word boundary wins over a hard cut. Never adds an
 * ellipsis: a name is a subject line, and a subject line does not trail off.
 */
function cut(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return stripTail(text);
  let space = -1;
  let clause = -1;
  // `points[max]` is the first code point past the cap, so a space there
  // means the cap already falls between two words.
  for (let i = 1; i <= max; i += 1) {
    if (points[i] !== " ") continue;
    space = i;
    const previous = points[i - 1];
    const at =
      previous === "-" && points[i - 2] === " "
        ? i - 2
        : previous === "," || previous === ";" || previous === ":"
          ? i - 1
          : -1;
    if (at >= CLAUSE_MIN) clause = at;
  }
  const end = clause >= 0 ? clause : space >= max / 2 ? space : max;
  return stripDanglingWords(points.slice(0, end).join(""));
}

/**
 * Caps a name that came from somewhere else (a model, a harness, a person)
 * at `max` code points on a word boundary. Returns null when nothing is left.
 */
export function capSubject(
  text: string | null | undefined,
  max: number = SESSION_SUBJECT_MAX,
): string | null {
  const flat = collapse(text ?? "");
  if (!flat) return null;
  const capped = cut(flat, max);
  return capped || null;
}

/**
 * Pulls GitHub pull request and issue URLs out of one line. A reference that
 * leads the line, or trails it with nothing to hang on, moves to `pending`
 * and comes back as " on PR 12". One inside the sentence becomes its label.
 */
function inlineRefs(line: string, pending: string[]): string {
  const bare = (text: string): string => text.replace(githubRefs(), " ");
  return line.replace(
    githubRefs(),
    (match: string, kind: string, number: string, offset: number, whole: string) => {
      const label = refLabel(kind, number);
      const before = bare(whole.slice(0, offset));
      const after = bare(whole.slice(offset + match.length));
      const leading = !HAS_WORD.test(before);
      const trailing = !HAS_WORD.test(after);
      // "review <url>" reads as "Review PR 12"; "fix conflicts <url>" reads
      // as "Fix conflicts on PR 12".
      const oneWord = /^\S+$/u.test(collapse(before).replace(LEAD_IN, ""));
      if (leading || (trailing && !oneWord && !PREPOSITION_TAIL.test(before))) {
        pending.push(label);
        return " ";
      }
      return label;
    },
  );
}

function firstSentence(line: string): string {
  for (const sentence of line.match(SENTENCE) ?? []) {
    const plain = stripTail(
      sentence.replace(LEAD_IN, "").replace(TRAILING_COURTESY, ""),
    ).trim();
    if (HAS_WORD.test(plain)) return plain;
  }
  return "";
}

/**
 * Names a session for the first prompt that started it, the way Claude Code
 * names one: a short subject in sentence case, at most
 * {@link SESSION_SUBJECT_MAX} code points, with no trailing punctuation.
 *
 * - Markup is dropped and whitespace collapsed, and the first line with words
 *   in it is the one that is read.
 * - A GitHub pull request or issue URL becomes "PR 123" or "issue 123". One
 *   that leads the prompt is named after the verb: a prompt of
 *   "https://github.com/o/r/pull/123 fix conflicts" is named
 *   "Fix conflicts on PR 123".
 * - The first sentence is kept, less a greeting or a "please" in front of it.
 * - A long sentence is cut at a clause or a word, never mid-word, and never
 *   with an ellipsis.
 *
 * Returns null for a prompt with no words in it.
 */
export function sessionSubject(prompt: string | null | undefined): string | null {
  const pending: string[] = [];
  let sentence = "";
  for (const raw of (prompt ?? "").replace(/<[^>]*>/gu, " ").split(/\r?\n/u)) {
    const flat = collapse(raw).replace(LIST_MARKER, "");
    if (!flat) continue;
    sentence = firstSentence(collapse(inlineRefs(flat, pending)));
    if (sentence) break;
  }
  const ref = pending[0];
  if (!sentence) return ref ? capitalize(ref) : null;
  const body = capitalize(sentence);
  const number = ref?.split(" ")[1];
  const named = ref && !new RegExp(String.raw`\b${number}\b`, "u").test(body);
  // A bare verb takes the reference as its object: "Review PR 12".
  const suffix = !named ? "" : /\s/u.test(body) ? ` on ${ref}` : ` ${ref}`;
  const room = SESSION_SUBJECT_MAX - Array.from(suffix).length;
  return `${cut(body, room)}${suffix}`;
}

/**
 * Keeps the first {@link SUMMARY_MAX_SENTENCES} sentences of a run summary,
 * within {@link SUMMARY_MAX_CHARS} code points. A summary written before the
 * cap existed can run to a page; this is how a view shows it in two or three
 * sentences without rewriting the stored row.
 *
 * A summary that ends in the notes `run.enrich` writes keeps them whole
 * (#4622). Each note says the account is partial, so a cut that dropped one
 * would show a partial account as complete. The model's sentences give way
 * instead, the way the writer stores a new account: each note takes one of
 * the sentences, and the first of the model's sentences always stays.
 */
export function clipSummary(
  text: string | null | undefined,
  maxSentences: number = SUMMARY_MAX_SENTENCES,
  maxChars: number = SUMMARY_MAX_CHARS,
): string | null {
  const flat = collapse(text ?? "");
  if (!flat) return null;
  const notes = TRAILING_NOTES.exec(flat);
  if (!notes) return clipSentences(flat, maxSentences, maxChars);
  const body = flat.slice(0, notes.index).trim();
  const tail = notes[1] ?? "";
  const room = maxChars - Array.from(tail).length - 1;
  if (!body || room < 2) return tail;
  const kept = Math.max(1, maxSentences - (tail.match(SENTENCE) ?? []).length);
  return `${clipSentences(body, kept, room)} ${tail}`;
}

function clipSentences(
  flat: string,
  maxSentences: number,
  maxChars: number,
): string {
  const sentences = (flat.match(SENTENCE) ?? []).slice(0, maxSentences);
  let kept = "";
  for (const sentence of sentences) {
    const next = kept ? `${kept} ${sentence}` : sentence;
    if (Array.from(next).length > maxChars) break;
    kept = next;
  }
  if (kept) return kept;
  const points = Array.from(sentences[0] ?? flat);
  const head = points.slice(0, maxChars - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).replace(TRAILING_PUNCT, "")}…`;
}
