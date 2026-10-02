// The files a memory PR writes: a new memory record, and an archived copy of
// a record the curator retires (ADR-206, decisions 6 and 9).
//
// Both are pure. The runner reads and writes the steering repo. A new record
// is `steering-record/v1` with `force: info`, `status: active`, and
// `origin: inferred`. Its provenance copies each memory it cites, with a null
// agent or run kept as null. A record a person promotes (promote_memories)
// keeps the kind, force, and effect the person chose, and its origin is
// `user`. A retirement changes one line, `status`, and leaves every other
// byte of the file as it was.
import { stringify } from "yaml";
import {
  parseFrontmatter,
  readSteeringRecord,
  splitRecordFile,
  STEERING_RECORD_FIELDS,
  type RecordEffect,
  type RecordForce,
  type RecordKind,
} from "@oxagen/oxagen/steering-repo/record";
import { memoryDescription, memoryLabel } from "./naming";
import type { MemoryRecordDraft } from "./types";

/** The kinds a memory record keeps. Every other kind is written as `memory`. */
const KEPT_KINDS: ReadonlySet<RecordKind> = new Set<RecordKind>([
  "code-rule",
  "business-rule",
  "fact",
]);

/** The kind a memory record is written with. */
export function memoryRecordKind(kind: RecordKind): RecordKind {
  return KEPT_KINDS.has(kind) ? kind : "memory";
}

/** A list without repeats, or undefined when it is null or empty. */
function listField(values: readonly string[] | null): string[] | undefined {
  if (values === null) return undefined;
  const kept = [...new Set(values)];
  return kept.length > 0 ? kept : undefined;
}

const NEW_UNREADABLE = "the memory record does not read as a steering record";
const ARCHIVE_UNREADABLE = "the record does not read, so it cannot be archived";

/** The error for a file that does not read as a record, with each issue the reader found. */
function unreadable(
  what: string,
  issues: ReadonlyArray<{ message: string }>,
): Error {
  const messages = issues.map((issue) => issue.message).join("; ");
  return new Error(`${what}: ${messages}`);
}

/**
 * A new memory record file. The body is the statement with LF line endings
 * and no blank lines around it. A record that names a repository has
 * `scope: repository`, and any other has `scope: workspace`. A null or empty
 * list is left out. Throws when the file would not read as a steering record,
 * such as for a draft that cites no memory.
 */
export function renderMemoryRecord(draft: MemoryRecordDraft): string {
  return renderRecord(draft, {
    kind: memoryRecordKind(draft.kind),
    force: "info",
    effect: null,
    origin: "inferred",
  });
}

/** A record a person promotes from memories, with the kind, force, and effect they chose. */
export interface PromotedRecordDraft extends MemoryRecordDraft {
  force: RecordForce;
  /** A constraint's effect. Null for every other kind. */
  effect: RecordEffect | null;
}

/**
 * A record file for promote_memories. It differs from the curator's in three
 * fields: the kind is the person's, so a constraint or a procedure stays one,
 * the force and the effect are the person's, and the origin is `user`, since
 * a person chose and checked it. The body, the scope, the targets, and the
 * provenance are written as the curator writes them. Throws when the file
 * would not read as a steering record, such as a constraint with no effect
 * or a force the kind does not allow.
 */
export function renderPromotedRecord(draft: PromotedRecordDraft): string {
  return renderRecord(draft, {
    kind: draft.kind,
    force: draft.force,
    effect: draft.effect,
    origin: "user",
  });
}

function renderRecord(
  draft: MemoryRecordDraft,
  chosen: {
    kind: RecordKind;
    force: RecordForce;
    effect: RecordEffect | null;
    origin: "user" | "inferred";
  },
): string {
  const statement = draft.statement.replace(/\r\n?/g, "\n").trim();
  const repos = listField(draft.repos);
  const fields: Record<string, unknown> = {
    schema: "steering-record/v1",
    lineage: draft.lineage,
    label: memoryLabel(statement),
    description: memoryDescription(statement),
    kind: chosen.kind,
    effect: chosen.effect ?? undefined,
    force: chosen.force,
    scope: repos === undefined ? "workspace" : "repository",
    repos,
    tools: listField(draft.tools),
    applies_to: listField(draft.appliesTo),
    status: "active",
    origin: chosen.origin,
    provenance: {
      source: "run",
      uri: draft.uri,
      memories: draft.memories.map((memory) => ({
        agent: memory.agent,
        run: memory.run,
        statement: memory.statement,
        evidence: [...memory.evidence],
      })),
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
  // The steering check reads every file a memory PR writes, so one that fails here would fail there.
  const read = readSteeringRecord(text);
  if (!read.ok) throw unreadable(NEW_UNREADABLE, read.issues);
  return text;
}

/**
 * A record file with `status: archived`. Only the status line changes, and a
 * record that is already archived comes back as it was. Throws when the
 * archived file does not read as a steering record.
 */
export function archiveRecordText(text: string): string {
  const split = splitRecordFile(text);
  if (!split.ok) throw unreadable(ARCHIVE_UNREADABLE, [split.issue]);
  const { frontmatter, body } = split.parts;
  // Line 1 is the first frontmatter line, so a key's line indexes `lines`.
  const parsed = parseFrontmatter(frontmatter, 1);
  if (!parsed.ok) throw unreadable(ARCHIVE_UNREADABLE, parsed.issues);
  const { value, key_lines } = parsed.frontmatter;
  const start = key_lines.get("status");
  let archived = text;
  if (value.status !== "archived" && start !== undefined) {
    const lines = frontmatter.split("\n");
    // A value that runs onto indented lines ends at the next key.
    const next =
      [...key_lines.values()]
        .sort((a, b) => a - b)
        .find((line) => line > start) ?? lines.length + 1;
    let end = start + 1;
    while (end < next && /^[ \t]/.test(lines[end - 1] as string)) end += 1;
    lines.splice(start - 1, end - start, "status: archived");
    archived = `---\n${lines.join("\n")}\n---\n${body}`;
  }
  // A file with no status line comes through unchanged and fails here.
  const read = readSteeringRecord(archived);
  if (!read.ok) throw unreadable(ARCHIVE_UNREADABLE, read.issues);
  return archived;
}
