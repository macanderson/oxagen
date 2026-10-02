// The context-record wizard's pure logic (roadmap creation-spec §5; mockup
// `wzRecSlug`, `wzRecLineage`, `wzRecStatement`, `wzRecTok`, `wzRecCe` and the
// force filter in `wzRecord` step 3). The steps and their tests read the
// record through these functions, so both agree on one reading.
//
// The file itself is not built here. open_context_pr writes it and stamps
// `record_id` and `record_hash` from its content on the server, so the bytes
// a reviewer sees are the bytes the checks hash. In a legacy repository (no
// `steering/governance.toml` on its production branch) that file is
// `.oxagen/rules/<lineage>.toml`, context-record/v0.1
// (packages/handlers/src/context.steering.file.ts). In a steering repository
// it is a Markdown steering record under `steering/`
// (packages/handlers/src/context.steering.record.ts). `recordPathFor` and
// `branchFor` below mirror that split so the wizard's preview names the path
// and the branch open_context_pr actually writes, never a guess. This module
// otherwise only shapes what the operator chooses: the lineage, the
// statement, the force and the effect.
import { CONTEXT_RECORD_LINEAGE } from "@oxagen/oxagen/context-record-label";
import { forcesFor as sharedForcesFor } from "@oxagen/oxagen/steering-repo/record-force";
import {
  LEGACY_RULES_DIR,
  MEMORY_DIR,
  recordFileName,
  STEERING_DIR,
} from "@oxagen/oxagen/steering-repo/paths";
import type {
  ConstraintEffect,
  RecordForce,
  RecordKind,
} from "@/data/contracts/steering";
import { estimateTokens, wordsOf } from "./draft-text";

/** The bound repository's layout, or null while it is unread or unbound. */
export type RepoLayout = "steering" | "legacy" | null;

/**
 * The folder under `steering/` a new record of this kind goes to, mirroring
 * `FOLDERS` in packages/handlers/src/context.steering.record.ts. Memory has
 * no folder here: it goes to `MEMORY_SHARD` instead.
 */
const STEERING_FOLDERS: Record<Exclude<RecordKind, "memory">, string> = {
  rule: "business-rules",
  constraint: "constraints",
  procedure: "procedures",
  fact: "facts",
  preference: "preferences",
};

/**
 * Where a new memory goes in a steering repository: the curator's shard for a
 * memory with no repository, path or tool, mirroring `memoryArea(null, null)`
 * in packages/handlers/src/memory/naming.ts.
 */
const MEMORY_SHARD = "workspace/general";

/**
 * The path a new record of this kind will hold once open_context_pr writes
 * it, given the bound repository's layout. Null while the layout is unread
 * or unbound, matching the handler's own refusal to guess.
 */
export function recordPathFor(
  layout: RepoLayout,
  kind: RecordKind,
  lineageId: string,
): string | null {
  if (layout === null) return null;
  if (layout === "legacy") return `${LEGACY_RULES_DIR}/${lineageId}.toml`;
  if (kind === "memory")
    return `${MEMORY_DIR}/${MEMORY_SHARD}/${recordFileName(lineageId)}`;
  return `${STEERING_DIR}/${STEERING_FOLDERS[kind]}/${recordFileName(lineageId)}`;
}

/**
 * The branch open_context_pr cuts for a record at `path`: `memory/<lineage>`
 * under the memory shard, `steering/<lineage>` everywhere else (both layouts
 * agree on this once the path is known). Null while `path` is null.
 */
export function branchFor(
  path: string | null,
  lineageId: string,
): string | null {
  if (path === null) return null;
  return path.startsWith(`${MEMORY_DIR}/`)
    ? `memory/${lineageId}`
    : `steering/${lineageId}`;
}

/** proposedRecordSchema's statement limit. */
export const STATEMENT_MAX = 2000;

const SLUG_MAX = 48;

/**
 * The forces a kind may carry (creation-spec §5 step 3). The rule lives in
 * `@oxagen/oxagen/steering-repo/record-force`, which the Markdown import's
 * contracts enforce too, so the wizard and the import agree. The first entry
 * is the wizard's default.
 */
export function forcesFor(kind: RecordKind): readonly RecordForce[] {
  return sharedForcesFor(kind);
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
 * mints (`ctx.core.do-not-re-read-changelog`). It is also the file stem
 * `recordPathFor` builds the new record's path from.
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
