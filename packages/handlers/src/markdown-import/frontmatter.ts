// markdown-import/frontmatter.ts: a Markdown file that is already one
// steering record. A file whose frontmatter says `schema: steering-record/v1`
// stays one record and keeps its frontmatter (discussions spec, Markdown
// import: Records). Any other frontmatter, such as a Cursor rule's or a
// skill's, is part of the text the model splits.
import {
  parseFrontmatter,
  readSteeringRecord,
  recordStatement,
  splitRecordFile,
  type SteeringRecord,
} from "@oxagen/oxagen/steering-repo/record";

export type FrontmatterRead =
  /** The file has no steering-record/v1 frontmatter. */
  | { kind: "none" }
  /** The file is one steering record. */
  | {
      kind: "record";
      record: SteeringRecord;
      /** The frontmatter's YAML, between the two --- lines. */
      frontmatter: string;
      /** The record's body, as its statement. */
      statement: string;
      /** The 1-based line the statement starts on: the body's first line with text. */
      bodyLine: number;
    }
  /** The frontmatter says steering-record/v1 and does not read as one. */
  | { kind: "invalid"; message: string };

/** Read a file as one steering record, when its frontmatter names the schema. */
export function readFrontmatterRecord(content: string): FrontmatterRead {
  const split = splitRecordFile(content);
  if (!split.ok) return { kind: "none" };
  const parsed = parseFrontmatter(split.parts.frontmatter);
  if (!parsed.ok || parsed.frontmatter.value.schema !== "steering-record/v1") {
    return { kind: "none" };
  }
  const read = readSteeringRecord(content);
  if (!read.ok) {
    const issues = read.issues
      .map((issue) => (issue.line ? `line ${issue.line}: ${issue.message}` : issue.message))
      .join("; ");
    return {
      kind: "invalid",
      message: `The file's steering-record/v1 frontmatter does not read as a record: ${issues}`,
    };
  }
  const blank = /^(\s*\n)*/.exec(read.body.replace(/\r\n/g, "\n"))?.[0] ?? "";
  return {
    kind: "record",
    record: read.record,
    frontmatter: split.parts.frontmatter,
    statement: recordStatement(read.body),
    bodyLine: read.body_line + (blank.match(/\n/g)?.length ?? 0),
  };
}
