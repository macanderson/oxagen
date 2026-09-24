// The context-record wizard's pure logic (roadmap creation-spec §5; mockup
// `wzRecSlug`, `wzRecLineage`, `wzRecStatement`, `wzRecTok`, `wzRecCe` and the
// force filter in `wzRecord` step 3). The steps and their tests read the
// record through these functions, so both agree on one reading.
//
// The file itself is not built here. open_context_pr writes
// `.oxagen/rules/<lineage>.toml` in the context-record/v0.1 format and stamps
// `record_id` and `record_hash` from its content on the server
// (packages/handlers/src/context.steering.file.ts), so the bytes a reviewer
// sees are the bytes the checks hash. This module only shapes what the
// operator chooses: the lineage, the statement, the force and the effect.
import { CONTEXT_RECORD_LINEAGE } from "@oxagen/oxagen/context-record-label";
import type {
  ConstraintEffect,
  RecordForce,
  RecordKind,
} from "@/data/contracts/steering";
import { estimateTokens, wordsOf } from "./draft-text";

/** proposedRecordSchema's statement limit. */
export const STATEMENT_MAX = 2000;

const SLUG_MAX = 48;

/**
 * The forces a kind may carry (creation-spec §5 step 3). A preference is soft,
 * so it is never `must` or `should`. A fact and a memory inform, so they are
 * `info`. The first entry is the default.
 */
export function forcesFor(kind: RecordKind): readonly RecordForce[] {
  if (kind === "preference") return ["may", "info"];
  if (kind === "fact" || kind === "memory") return ["info"];
  return ["must", "should", "may", "info"];
}

/** The force the draft holds, or the kind's default when the kind forbids it. */
export function forceOf(
  kind: RecordKind,
  force: RecordForce | null,
): RecordForce {
  const allowed = forcesFor(kind);
  if (force !== null && allowed.includes(force)) return force;
  return allowed[0] ?? "info";
}

/**
 * Whether the kind carries a constraint effect. Only a constraint does:
 * proposedRecordSchema refuses an effect on every other kind. The mockup also
 * offers one on a rule, and the contract wins on data.
 */
export function hasEffect(kind: RecordKind | null): kind is "constraint" {
  return kind === "constraint";
}

/** Must and should ride the stable prefix; may and info are selected by relevance. */
export function isStable(force: RecordForce): boolean {
  return force === "must" || force === "should";
}

/** The slug a description implies: its first four words, kebab-case. */
function slugOf(desc: string): string {
  return (
    wordsOf(desc).slice(0, 4).join("-").slice(0, SLUG_MAX).replace(/-+$/, "") ||
    "new-record"
  );
}

/**
 * The lineage id a description implies in a workspace:
 * `ctx.<first segment of the workspace slug>.<slug>`, the shape the mockup
 * mints (`ctx.core.do-not-re-read-changelog`). It is also the file stem under
 * `.oxagen/rules/` and the branch `context/<lineage>`.
 */
export function lineageOf(ws: string, desc: string): string {
  const set =
    (ws.split("-")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || "ws";
  const id = `ctx.${set}.${slugOf(desc)}`;
  return CONTEXT_RECORD_LINEAGE.test(id) ? id : `ctx.${set}.new-record`;
}

/**
 * The statement as the record carries it: one line, with every run of
 * whitespace collapsed to a single space. The contract calls the field the
 * single-sentence claim, and the file that open_context_pr writes escapes a
 * newline rather than wrapping the string, so a line break typed or pasted
 * into the editor would reach every surface that preserves whitespace (the
 * wizard preview, the Context PR body, the turn the record is rendered into)
 * as a sentence broken mid-way. Collapsing it here keeps the editor free-form
 * and the record one line. #3736 is the case without it: a revision whose
 * only change was six line breaks inside the sentence.
 */
export function normalizeStatement(statement: string): string {
  return statement.trim().replace(/\s+/g, " ");
}

/**
 * The statement drafted from a description: the description itself,
 * capitalized, with a full stop. A procedure keeps its own punctuation, since
 * its steps may already be numbered.
 */
export function seedStatement(desc: string, kind: RecordKind | null): string {
  const d = normalizeStatement(desc);
  if (d === "") return "";
  const capital = d.charAt(0).toUpperCase() + d.slice(1);
  if (kind === "procedure") return capital;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** What the statement adds to a turn it is rendered into, at four characters a token. */
export function statementTokens(statement: string): number {
  return estimateTokens(normalizeStatement(statement));
}

/** The record propose_record is sent, minus the rationale. */
export type RecordChoice = {
  lineageId: string;
  label?: string;
  kind: RecordKind;
  force: RecordForce;
  constraintEffect?: ConstraintEffect;
  sharingScope: "workspace";
  statement: string;
};

/**
 * A stable key for a record choice. The wizard keeps the proposal it made
 * under this key, so a retry after a failed open reuses it, and an edit after
 * that proposes again rather than opening a pull request for words the
 * operator changed.
 */
export function choiceKey(choice: RecordChoice): string {
  return JSON.stringify([
    choice.lineageId,
    choice.label ?? null,
    choice.kind,
    choice.force,
    choice.constraintEffect ?? null,
    choice.sharingScope,
    choice.statement,
  ]);
}
