// context.steering.record.ts: the steering record a Context PR writes in a
// steering repo (#4731).
//
// A legacy repo keeps one TOML file per record under .oxagen/rules/. A
// steering repo reads each record as Markdown with YAML frontmatter
// (steering-record/v1) at any path under steering/, and its required check
// refuses a steering/ branch that changes .oxagen/rules/. So in a steering
// repo, open_context_pr writes the proposal as a steering record:
//
// - A new record goes to steering/<folder>/<lineage>.md. The spec gives
//   folders no meaning, so the folder names the record's kind, the one field
//   every proposal carries: steering/business-rules/ for a rule,
//   steering/constraints/ for a constraint, and so on. A memory goes where
//   the curator puts one with no repository and no path,
//   steering/memory/workspace/general/, on a memory/ branch.
// - A revision is written where the record lives now, from the fields its
//   file holds there. The proposal sets the fields it owns and the rest stay.
//
// The file carries no id or hash. Oxagen writes both when the steering PR
// merges, as for every steering record.
import { stringify } from "yaml";
import { HandlerError } from "@oxagen/oxagen";
import type {
  ConstraintEffect,
  RecordKind as ProposalKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  classifySteeringRepoPath,
  recordFileName,
  STEERING_DIR,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  readSteeringRecord,
  recordStatement,
  STEERING_RECORD_FIELDS,
  type RecordKind,
  type SteeringRecord,
} from "@oxagen/oxagen/steering-repo/record";
import { memoryRecordPath } from "./memory/naming";
import { stampRecordText } from "./steering-repo/stamp";

/** The folder under steering/ a new record of each proposal kind but memory goes to. */
const FOLDERS: Record<Exclude<ProposalKind, "memory">, string> = {
  rule: "business-rules",
  constraint: "constraints",
  procedure: "procedures",
  fact: "facts",
  preference: "preferences",
};

/** The steering record kind each proposal kind is written as. */
const KINDS: Record<ProposalKind, RecordKind> = {
  rule: "business-rule",
  constraint: "constraint",
  procedure: "procedure",
  fact: "fact",
  preference: "preference",
  memory: "memory",
};

const RULE_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>([
  "business-rule",
  "code-rule",
]);

/**
 * Where a new record of this kind goes: `steering/<folder>/<lineage>.md`, or
 * for a memory the path the curator gives a memory with no repository, path,
 * or tool.
 */
export function steeringRecordPath(kind: ProposalKind, lineage: string): string {
  if (kind === "memory") return memoryRecordPath(null, null, null, lineage);
  return `${STEERING_DIR}/${FOLDERS[kind]}/${recordFileName(lineage)}`;
}

/** True for a path the steering layout reads as a steering record. */
export function isSteeringRecordPath(path: string | null): path is string {
  return path !== null && classifySteeringRepoPath(path) === "record";
}

/**
 * The kind a proposal is written as. A rule is a business rule, unless the
 * record it revises is already a code rule or a business rule.
 */
export function steeringRecordKind(
  kind: ProposalKind,
  held: RecordKind | null = null,
): RecordKind {
  if (kind === "rule" && held !== null && RULE_KINDS.has(held)) return held;
  return KINDS[kind];
}

/** Does a file of kind `inFile` carry a proposal of kind `proposed`? */
export function kindCarriesProposal(
  proposed: ProposalKind,
  inFile: RecordKind,
): boolean {
  return proposed === "rule" ? RULE_KINDS.has(inFile) : KINDS[proposed] === inFile;
}

/** What a steering record is written from: the proposal's fields. */
export interface SteeringRecordDraft {
  lineageId: string;
  label: string;
  kind: ProposalKind;
  constraintEffect: ConstraintEffect | null;
  force: string;
  sharingScope: string;
  statement: string;
  /** Who raised the proposal: a person, or an agent over an API key. */
  origin: "user" | "inferred";
  proposalPublicId: string;
}

/** A rendered steering record, and the id and hash the merge will stamp into it. */
export interface SteeringRecordFile {
  text: string;
  id: string;
  hash: string;
}

/** The statement as a record body holds it: LF line endings, trimmed. */
function bodyOf(statement: string): string {
  return statement.replace(/\r\n?/g, "\n").trim();
}

/**
 * Render a proposal as a steering record. `current` is the text of the file
 * the record lives in now, for a revision. When it reads as a steering
 * record, the file keeps its tools, skills, toolbelt, applies_to and load,
 * its repos while the scope stays repository, and its description while the
 * statement stays the same. The proposal sets every other field.
 *
 * Refuses `repository_scope_needs_repo` for a repository scope with no repos
 * to keep: a proposal names no repository, and a steering record with
 * `scope: repository` must list one.
 */
export function renderSteeringRecord(
  draft: SteeringRecordDraft,
  current: string | null = null,
): SteeringRecordFile {
  const statement = bodyOf(draft.statement);
  const read = current === null ? null : readSteeringRecord(current);
  const held: Partial<SteeringRecord> = read?.ok ? read.record : {};
  const sameStatement =
    read?.ok === true && recordStatement(read.body).trim() === statement;
  const kind = steeringRecordKind(draft.kind, held.kind ?? null);
  const repos = draft.sharingScope === "repository" ? held.repos : undefined;
  if (draft.sharingScope === "repository" && repos === undefined) {
    throw new HandlerError({
      code: "conflict",
      reason: "repository_scope_needs_repo",
      message: `A steering record with repository scope lists the repositories it reaches, and the proposal on ${draft.lineageId} names none. Propose it with workspace scope, or add repos to the record in the steering repo.`,
    });
  }
  const fields: Record<string, unknown> = {
    schema: "steering-record/v1",
    lineage: draft.lineageId,
    label: draft.label,
    description: sameStatement ? held.description : undefined,
    kind,
    effect:
      kind === "constraint" ? (draft.constraintEffect ?? undefined) : undefined,
    force: draft.force,
    scope: draft.sharingScope,
    repos,
    tools: held.tools,
    skills: held.skills,
    toolbelt: held.toolbelt,
    applies_to: held.applies_to,
    load: held.load,
    status: "active",
    origin: draft.origin,
    provenance: {
      source: "proposal",
      uri: `oxagen:proposal/${draft.proposalPublicId}`,
    },
  };
  // The fields go in the order the schema lists them, as Oxagen writes every record.
  const ordered: Record<string, unknown> = {};
  for (const field of STEERING_RECORD_FIELDS) {
    if (fields[field] !== undefined) ordered[field] = fields[field];
  }
  // A record refuses anchors and aliases, and a folded line would hide a value's end.
  const yaml = stringify(ordered, { aliasDuplicateObjects: false, lineWidth: 0 });
  const text = `---\n${yaml}---\n\n${statement}\n`;
  // The Schema check reads the file back, so a file that fails here would fail there.
  const checked = readSteeringRecord(text);
  if (!checked.ok) {
    throw new HandlerError({
      code: "conflict",
      reason: "record_unreadable",
      message: `The proposal on ${draft.lineageId} does not make a steering record: ${checked.issues.map((issue) => issue.message).join("; ")}`,
    });
  }
  const stamped = stampRecordText(text);
  if (!stamped.ok) {
    throw new HandlerError({
      code: "conflict",
      reason: "record_unreadable",
      message: `The steering record for ${draft.lineageId} cannot be stamped: ${stamped.message}`,
    });
  }
  return { text, id: stamped.id, hash: stamped.hash };
}
