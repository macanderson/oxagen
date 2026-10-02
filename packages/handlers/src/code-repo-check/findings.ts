// code-repo-check/findings.ts: the instruction-file statements that repeat or
// contradict a published steering record (steering-repo-spec, Code repository
// checks: Instruction files).
//
// The comparison is the steering conflicts check's own test
// (`similarStatements` in @oxagen/steering-check), the one the Markdown import
// also runs, so a line this flags is a line a steering PR's conflicts check
// would flag too. It runs no model. Two passes compare each added statement
// with each record:
//
// 1. Repeat. The two texts are the same words, or, when both have at least
//    eight distinct words, share 90 percent of them.
// 2. Contradiction. The conflicts check's opposite-constraint rule: two
//    constraints on the same statement, one require and one forbid. A line in
//    an instruction file has no effect field, so its effect comes from its
//    words: a line with "never", "do not", "must not", "avoid", and the like
//    forbids, and any other line requires. A constraint record keeps the
//    effect it was published with. Each text is then compared without those
//    words ("Never push to main" and "Always push to main" both become "push
//    to main"). The same statement with opposite effects is a contradiction,
//    and with the same effect it is a repeat.
//
// Each side is compared whole and sentence by sentence, because a record's
// body often holds two sentences where an instruction file holds one.
import {
  similarStatements,
  type ComparedStatement,
} from "@oxagen/steering-check";
import { wordCount, type AddedStatement, STATEMENT_MIN_WORDS } from "./statements";

/** A published steering record, as the registry holds it. */
export interface PublishedStatement {
  lineage: string;
  label: string | null;
  kind: string;
  /** `require` or `forbid` on a constraint, null on every other kind. */
  effect: string | null;
  statement: string;
  /** Where the record lives in the steering repo, or null when Oxagen does not know. */
  path: string | null;
}

export type FindingKind = "repeat" | "contradiction";

/** One added statement that repeats or contradicts a steering record. */
export interface StatementFinding {
  kind: FindingKind;
  statement: AddedStatement;
  record: { lineage: string; label: string | null; path: string | null };
}

/** What the comparison found, and the added statements no record already holds. */
export interface Comparison {
  findings: StatementFinding[];
  /** Added statements that neither repeat nor contradict a record. */
  fresh: AddedStatement[];
}

type Effect = "require" | "forbid";

const FORBID_WORDS =
  /\b(?:never|do not|don't|dont|does not|doesn't|must not|mustn't|should not|shouldn't|cannot|can't|can not|may not|no longer|avoid|forbid|forbidden|prohibit|prohibited)\b/;

/**
 * The words that set a statement's effect or force, longest first, so "must
 * not" goes before "must". Removing them leaves what the statement is about.
 */
const EFFECT_WORDS = [
  "you must not",
  "you should not",
  "you may not",
  "you cannot",
  "you can't",
  "you must",
  "you should",
  "make sure to",
  "make sure",
  "be sure to",
  "must not",
  "mustn't",
  "should not",
  "shouldn't",
  "do not",
  "don't",
  "dont",
  "does not",
  "doesn't",
  "cannot",
  "can't",
  "can not",
  "may not",
  "no longer",
  "never",
  "always",
  "avoid",
  "must",
  "should",
  "please",
];
const EFFECT_PATTERN = new RegExp(`\\b(?:${EFFECT_WORDS.join("|")})\\b`, "g");

/** Lowercase, with curly apostrophes made straight. */
function plain(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'");
}

/** The effect a statement's words give it: forbid for a prohibition, else require. */
export function effectOfText(text: string): Effect {
  return FORBID_WORDS.test(plain(text)) ? "forbid" : "require";
}

/** The statement without the words that set its effect or force. */
export function coreOf(text: string): string {
  return plain(text).replace(EFFECT_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/** The sentences of a text, when it holds more than one worth comparing. */
export function sentencesOf(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(*_[])/)
    .map((s) => s.trim())
    .filter((s) => wordCount(s) >= STATEMENT_MIN_WORDS);
  return sentences.length > 1 ? sentences : [];
}

interface Unit extends ComparedStatement {
  side: "record" | "added";
  /** The record's or the added statement's index. */
  index: number;
  /** The unit's effect, for the contradiction pass. */
  polarity: Effect;
}

function unitsOf(
  side: Unit["side"],
  index: number,
  text: string,
  wholeEffect: Effect,
): Unit[] {
  const units: Unit[] = [
    {
      side,
      index,
      lineage: `${side}:${index}:0`,
      kind: "statement",
      effect: null,
      statement: text,
      polarity: wholeEffect,
    },
  ];
  sentencesOf(text).forEach((sentence, n) => {
    units.push({
      side,
      index,
      lineage: `${side}:${index}:${n + 1}`,
      kind: "statement",
      effect: null,
      statement: sentence,
      polarity: effectOfText(sentence),
    });
  });
  return units;
}

/** A record's effect: its own on a constraint, else the one its words give. */
function recordEffect(record: PublishedStatement): Effect {
  if (
    record.kind === "constraint" &&
    (record.effect === "require" || record.effect === "forbid")
  )
    return record.effect;
  return effectOfText(record.statement);
}

/** The record and added indexes of a pair that crosses the two sides, or null. */
function crossing(a: Unit, b: Unit): { record: number; added: number } | null {
  if (a.side === b.side) return null;
  return a.side === "record"
    ? { record: a.index, added: b.index }
    : { record: b.index, added: a.index };
}

/**
 * Compare each added statement with each published record. An added
 * statement gets at most one finding: a contradiction when it has one, or
 * else a repeat, each against the first record in `records` order.
 */
export function compareStatements(
  added: readonly AddedStatement[],
  records: readonly PublishedStatement[],
): Comparison {
  const units: Unit[] = [
    ...records.flatMap((record, i) =>
      unitsOf("record", i, record.statement, recordEffect(record)),
    ),
    ...added.flatMap((statement, i) =>
      unitsOf("added", i, statement.text, effectOfText(statement.text)),
    ),
  ];

  const repeats = new Map<number, number>();
  const contradictions = new Map<number, number>();
  const note = (into: Map<number, number>, pair: { record: number; added: number }) => {
    const held = into.get(pair.added);
    if (held === undefined || pair.record < held) into.set(pair.added, pair.record);
  };

  // Pass 1: the same words.
  for (const { a, b } of similarStatements(units)) {
    const pair = crossing(a, b);
    if (pair) note(repeats, pair);
  }

  // Pass 2: the same statement without its effect words, compared as two
  // constraints whose effects are the units' polarities.
  const cores: Unit[] = [];
  for (const unit of units) {
    const core = coreOf(unit.statement);
    if (wordCount(core) < 2) continue;
    cores.push({ ...unit, kind: "constraint", effect: unit.polarity, statement: core });
  }
  for (const { a, b, opposite } of similarStatements(cores)) {
    const pair = crossing(a, b);
    if (pair) note(opposite ? contradictions : repeats, pair);
  }

  const findings: StatementFinding[] = [];
  const fresh: AddedStatement[] = [];
  added.forEach((statement, i) => {
    const contradicted = contradictions.get(i);
    const repeated = repeats.get(i);
    const kind: FindingKind | null =
      contradicted !== undefined ? "contradiction" : repeated !== undefined ? "repeat" : null;
    const recordIndex = contradicted ?? repeated;
    const record = recordIndex === undefined ? undefined : records[recordIndex];
    if (kind === null || record === undefined) {
      fresh.push(statement);
      return;
    }
    findings.push({
      kind,
      statement,
      record: { lineage: record.lineage, label: record.label, path: record.path },
    });
  });
  return { findings, fresh };
}
