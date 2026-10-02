// conflicts.ts: a record that says what an active one already says, or
// requires what an active one forbids.
import { recordStatement } from "@oxagen/oxagen/steering-repo";
import type { TreeCheck, TreeEnv } from "../finding";
import { finder } from "../finding";
import { recordFieldLine, recordFiles, type RecordFile } from "../repo";
import type { Finding, SteeringTree } from "../types";

const find = finder("conflicts");

/** Two statements this alike say the same thing. */
export const NEAR_DUPLICATE_SIMILARITY = 0.9;
/** A statement this short is compared only for an exact match. */
export const NEAR_DUPLICATE_MIN_WORDS = 8;

/**
 * One statement to compare: a record's lineage, kind, effect, and statement.
 * The Markdown import (packages/handlers/src/markdown-import/) compares its
 * statements with the same test, so the import and this check agree.
 */
export interface ComparedStatement {
  lineage: string;
  kind: string;
  effect: string | null;
  statement: string;
}

/** Two statements that say the same thing, and whether they are constraints with opposite effects. */
export interface StatementMatch<T extends ComparedStatement> {
  a: T;
  b: T;
  /** True for two constraints on the same statement where one requires and one forbids. */
  opposite: boolean;
}

/** One active record: a file in the tree, or a published record from elsewhere. */
interface Active {
  lineage: string;
  kind: string;
  effect: string | null;
  /** The file in the tree, or null for a published record the tree does not hold. */
  file: RecordFile | null;
}

interface Compared<T> {
  entry: T;
  set: ReadonlySet<string>;
  normalized: string;
}

function wordsOf(statement: string): string[] {
  return statement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
}

function compared<T extends ComparedStatement>(entry: T): Compared<T> {
  const words = wordsOf(entry.statement);
  return { entry, set: new Set(words), normalized: words.join(" ") };
}

/** How alike two statements are: 1 for the same words, 0 for none in common. */
function similarity<T>(a: Compared<T>, b: Compared<T>): number {
  if (a.normalized === b.normalized) return 1;
  if (a.set.size < NEAR_DUPLICATE_MIN_WORDS || b.set.size < NEAR_DUPLICATE_MIN_WORDS) return 0;
  let shared = 0;
  for (const word of a.set) if (b.set.has(word)) shared += 1;
  return shared / (a.set.size + b.set.size - shared);
}

function opposite(a: ComparedStatement, b: ComparedStatement): boolean {
  return (
    a.kind === "constraint" &&
    b.kind === "constraint" &&
    a.effect !== null &&
    b.effect !== null &&
    a.effect !== b.effect
  );
}

/**
 * Every pair of statements that say the same thing: an exact match of their
 * words, or a word-set overlap of NEAR_DUPLICATE_SIMILARITY or more when both
 * have at least NEAR_DUPLICATE_MIN_WORDS distinct words. Each pair appears
 * once, with the statement that has fewer distinct words as `a`.
 */
export function similarStatements<T extends ComparedStatement>(
  entries: readonly T[],
): StatementMatch<T>[] {
  // A pair can only reach the threshold when the two word counts are close,
  // so sorting by size lets the inner loop stop early.
  const bySize = entries.map(compared).sort((a, b) => a.set.size - b.set.size);
  const matches: StatementMatch<T>[] = [];
  for (let i = 0; i < bySize.length; i += 1) {
    const a = bySize[i] as Compared<T>;
    for (let j = i + 1; j < bySize.length; j += 1) {
      const b = bySize[j] as Compared<T>;
      if (a.normalized !== b.normalized && a.set.size < b.set.size * NEAR_DUPLICATE_SIMILARITY) break;
      if (similarity(a, b) < NEAR_DUPLICATE_SIMILARITY) continue;
      matches.push({ a: a.entry, b: b.entry, opposite: opposite(a.entry, b.entry) });
    }
  }
  return matches;
}

function active(
  lineage: string,
  kind: string,
  effect: string | null,
  file: RecordFile | null,
  statement: string,
): Active & ComparedStatement {
  return { lineage, kind, effect, file, statement };
}

/** Every active record the tree holds, and every published one it does not. */
function activeRecords(tree: SteeringTree, index: TreeEnv["index"]): (Active & ComparedStatement)[] {
  const records: (Active & ComparedStatement)[] = [];
  const held = new Set<string>();
  for (const file of recordFiles(tree)) {
    if (file.lineage !== null) held.add(file.lineage);
    const record = file.record;
    if (record === null || record.status !== "active") continue;
    records.push(active(record.lineage, record.kind, record.effect ?? null, file, recordStatement(file.body)));
  }
  for (const record of index?.records ?? []) {
    if (held.has(record.lineage) || !record.statement) continue;
    records.push(active(record.lineage, record.kind, record.effect ?? null, null, record.statement));
  }
  return records;
}

/** Where to point at a record: its effect line for a constraint pair, its body otherwise. */
function place(
  tree: SteeringTree,
  file: RecordFile,
  field: "effect" | null,
): { line: number | null; field: string | null } {
  if (field === null) return { line: file.body_line, field: null };
  return { line: recordFieldLine(file, tree.get(file.path) as string, field), field };
}

function pairFinding(tree: SteeringTree, file: RecordFile, self: Active, other: Active, isOpposite: boolean): Finding {
  const where = other.file ? `${other.lineage} in ${other.file.path}` : `the published record ${other.lineage}`;
  if (isOpposite) {
    return find({
      rule: "opposite-constraint",
      path: file.path,
      ...place(tree, file, "effect"),
      message: `This constraint's effect is ${self.effect ?? ""}, and ${where} is a ${other.effect ?? ""} constraint on the same statement. Both cannot hold.`,
      expected: "No two active constraints that require and forbid the same thing.",
      fix: `Keep one of the two. Archive ${other.lineage}, or change this record's statement or effect.`,
    });
  }
  return find({
    rule: "near-duplicate",
    path: file.path,
    ...place(tree, file, null),
    message: `This record says what ${where} already says.`,
    expected: "Each active record says something no other active record says.",
    fix: `Revise ${other.lineage} instead of adding a second record, or archive one of the two.`,
  });
}

/**
 * A published constraint the head flips in place. A revision cannot turn a
 * forbid into a require, because every run that read the old record acted on it.
 */
function flips(tree: SteeringTree, env: TreeEnv): Finding[] {
  const published = new Map<string, string>();
  for (const record of env.index?.records ?? []) {
    if (record.kind === "constraint" && record.effect) published.set(record.lineage, record.effect);
  }
  if (env.base) {
    for (const file of recordFiles(env.base)) {
      const record = file.record;
      if (record?.kind === "constraint" && record.effect) published.set(record.lineage, record.effect);
    }
  }
  const findings: Finding[] = [];
  for (const file of recordFiles(tree)) {
    const record = file.record;
    if (record?.kind !== "constraint" || !record.effect) continue;
    const before = published.get(record.lineage);
    if (before === undefined || before === record.effect) continue;
    findings.push(
      find({
        rule: "effect-flip",
        path: file.path,
        ...place(tree, file, "effect"),
        message: `The published constraint ${record.lineage} is a ${before}, and this change makes it a ${record.effect}.`,
        expected: `effect: ${before}, as published.`,
        fix: "Archive this record, and open a new record with its own lineage for the opposite effect.",
      }),
    );
  }
  return findings;
}

export const conflictsCheck: TreeCheck = (tree, env) => {
  const findings: Finding[] = [];
  for (const { a, b, opposite: isOpposite } of similarStatements(activeRecords(tree, env.index))) {
    if (a.file) findings.push(pairFinding(tree, a.file, a, b, isOpposite));
    if (b.file) findings.push(pairFinding(tree, b.file, b, a, isOpposite));
  }
  return [...findings, ...flips(tree, env)];
};
