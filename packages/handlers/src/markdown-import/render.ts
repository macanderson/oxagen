// markdown-import/render.ts: the files commit_markdown_import writes.
//
// A record goes where open_steering_pr puts a new record of its kind
// (context.steering.record.ts): steering/<kind folder>/<lineage>.md, a skill
// in its own folder as steering/skills/<lineage>/SKILL.md, and a memory where
// the curator puts one with no repository, path, or tool. A record whose
// lineage is already published is written at the path it holds now, when
// that path is a steering record's, so the import revises it there instead of
// adding a second file.
//
// A split statement gets fresh frontmatter with `origin: user` and
// `provenance.source: import`. A file that was a steering record already
// keeps its frontmatter, with the fields the row owns set from the row and
// no `id` or `hash`: Oxagen writes both when the steering PR merges.
import { stringify } from "yaml";
import { HandlerError } from "@oxagen/oxagen";
import type { MarkdownImportRecord } from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import {
  classifySteeringRepoPath,
  recordFileName,
  skillFilePath,
  STEERING_DIR,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  parseFrontmatter,
  readSteeringRecord,
  STEERING_RECORD_FIELDS,
  type RecordKind,
} from "@oxagen/oxagen/steering-repo/record";
import { SKILL_DESCRIPTION_MAX } from "@oxagen/oxagen/steering-repo/tokens";
import { memoryRecordPath } from "../memory/naming";
import { firstSentence, slugPart } from "./naming";

/** The folder under steering/ a new record of each kind but skill and memory goes to. */
const FOLDERS: Record<Exclude<RecordKind, "skill" | "memory">, string> = {
  "business-rule": "business-rules",
  "code-rule": "code-rules",
  constraint: "constraints",
  procedure: "procedures",
  fact: "facts",
  preference: "preferences",
};

/**
 * Where a record of `kind` goes: `published`, the path its lineage holds now,
 * when that path holds a steering record of the same shape, else the path a
 * new record of the kind takes. A legacy `.oxagen/rules/` path, or a skill's
 * folder for a kind that is not a skill, is never reused.
 */
export function importRecordPath(
  kind: RecordKind,
  lineage: string,
  published: string | null = null,
): string {
  if (published !== null) {
    const shape = classifySteeringRepoPath(published);
    if (kind === "skill" ? shape === "skill-record" : shape === "record") return published;
  }
  if (kind === "skill") return skillFilePath(lineage);
  if (kind === "memory") return memoryRecordPath(null, null, null, lineage);
  return `${STEERING_DIR}/${FOLDERS[kind]}/${recordFileName(lineage)}`;
}

/** The `uri` an imported record cites: the file and the line it came from. */
export function importUri(file: string, line: number): string {
  const path = file
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `oxagen:import/${path}#L${line}`;
}

/** A skill's folder name, as harnesses expect: the lineage's last part. */
function skillName(lineage: string): string {
  return slugPart(lineage.split(".").pop() ?? "") || "skill";
}

/** The statement as a record body holds it: LF line endings, trimmed. */
function bodyOf(statement: string): string {
  return statement.replace(/\r\n?/g, "\n").trim();
}

function unreadable(row: MarkdownImportRecord, message: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "record_unreadable",
    message: `${row.file} line ${row.line} (${row.lineage}) does not make a steering record: ${message}`,
  });
}

/** The frontmatter fields a row's frontmatter record keeps. */
function heldFields(row: MarkdownImportRecord): Record<string, unknown> {
  if (row.frontmatter === null) return {};
  const parsed = parseFrontmatter(row.frontmatter);
  if (!parsed.ok) {
    throw unreadable(row, parsed.issues.map((issue) => issue.message).join("; "));
  }
  return parsed.frontmatter.value;
}

/**
 * The file text of one record row. The Schema check reads the file back, so
 * a row that fails here would fail the steering PR, and the call refuses it
 * with `record_unreadable` before anything is written.
 */
export function renderImportRecord(row: MarkdownImportRecord): string {
  const statement = bodyOf(row.statement);
  const held = heldFields(row);
  const isSkill = row.kind === "skill";
  const fields: Record<string, unknown> =
    row.origin === "frontmatter"
      ? {
          ...held,
          lineage: row.lineage,
          label: row.label,
          kind: row.kind,
          name: isSkill ? (held.name ?? skillName(row.lineage)) : undefined,
          description: isSkill
            ? (held.description ?? firstSentence(statement, SKILL_DESCRIPTION_MAX))
            : held.description,
          effect: row.effect ?? undefined,
          force: row.force,
          id: undefined,
          hash: undefined,
        }
      : {
          schema: "steering-record/v1",
          lineage: row.lineage,
          label: row.label,
          description: firstSentence(
            statement,
            isSkill ? SKILL_DESCRIPTION_MAX : undefined,
          ),
          kind: row.kind,
          name: isSkill ? skillName(row.lineage) : undefined,
          effect: row.effect ?? undefined,
          force: row.force,
          scope: "workspace",
          status: "active",
          origin: "user",
          provenance: { source: "import", uri: importUri(row.file, row.line) },
        };
  // The fields go in the order the schema lists them, as Oxagen writes every record.
  const ordered: Record<string, unknown> = {};
  for (const field of STEERING_RECORD_FIELDS) {
    if (fields[field] !== undefined && fields[field] !== "") ordered[field] = fields[field];
  }
  // A record refuses anchors and aliases, and a folded line would hide a value's end.
  const yaml = stringify(ordered, { aliasDuplicateObjects: false, lineWidth: 0 });
  const text = `---\n${yaml}---\n\n${statement}\n`;
  const checked = readSteeringRecord(text);
  if (!checked.ok) {
    throw unreadable(row, checked.issues.map((issue) => issue.message).join("; "));
  }
  return text;
}
