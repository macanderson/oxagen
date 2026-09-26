// files.ts: reading a steering repo's TOML and JSON Lines files against their
// schemas, with the file-format rules every file shares (steering-repo-spec,
// File formats): UTF-8 with no byte-order mark, LF line endings, a final
// newline, and, for TOML, a first line that names the schema.
//
// A failure names the line and the field where the file shows them, so the
// checks and `oxagen check` can print a fix an agent can act on.
import { parse as parseToml } from "smol-toml";
import type { z } from "zod";
import { schemaDirective, type SchemaId } from "./schema-ids";

/** One thing wrong with a file. `line` is 1-based. */
export interface FileIssue {
  line: number | null;
  /** The field's path, dot-joined, such as `memory.auto_merge`. */
  field: string | null;
  message: string;
}

/** A file read against its schema: the value, or every issue found. */
export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: FileIssue[] };

/** What breaks the encoding rules every steering repo file follows. */
export function encodingIssues(text: string): FileIssue[] {
  if (text === "") {
    return [{ line: null, field: null, message: "the file is empty" }];
  }
  const issues: FileIssue[] = [];
  if (text.startsWith("﻿")) {
    issues.push({
      line: 1,
      field: null,
      message: "the file starts with a byte-order mark. Save it as UTF-8 without one.",
    });
  }
  const carriage = text.indexOf("\r");
  if (carriage >= 0) {
    issues.push({
      line: text.slice(0, carriage).split("\n").length,
      field: null,
      message: "the file has CRLF line endings. Use LF.",
    });
  }
  if (!text.endsWith("\n")) {
    issues.push({
      line: text.split("\n").length,
      field: null,
      message: "the file does not end with a newline",
    });
  }
  return issues;
}

/** zod's issues as file issues, with the line of each top-level field when known. */
export function schemaIssues(
  error: z.ZodError,
  lineOf: (field: string) => number | null = () => null,
): FileIssue[] {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join(".") : null;
    const top = issue.path[0];
    return {
      line: typeof top === "string" ? lineOf(top) : null,
      field,
      message: issue.message,
    };
  });
}

/**
 * A TOML file read against its schema. The first line must be
 * `#:schema https://oxagen.sh/schemas/<id>.json`, and unknown keys fail
 * because every schema here is strict.
 */
export function readTomlFile<T extends z.ZodTypeAny>(
  text: string,
  id: SchemaId,
  schema: T,
): ReadResult<z.output<T>> {
  const issues = encodingIssues(text);
  if (issues.length > 0) return { ok: false, issues };
  const directive = schemaDirective(id);
  if (text.split("\n", 1)[0] !== directive) {
    return {
      ok: false,
      issues: [
        {
          line: 1,
          field: null,
          message: `the first line must be ${directive}`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = parseToml(text);
  } catch (error) {
    const { line, message } = error as { line?: number; message: string };
    return {
      ok: false,
      issues: [
        {
          line: line ?? null,
          field: null,
          message: `the file is not TOML: ${message.split("\n", 1)[0] as string}`,
        },
      ],
    };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: schemaIssues(parsed.error, keyLines(text)) };
  }
  return { ok: true, value: parsed.data as z.output<T> };
}

/** The line a top-level TOML key or table header first appears on. */
function keyLines(text: string): (field: string) => number | null {
  const lines = text.split("\n");
  return (field) => {
    const index = lines.findIndex((line) => {
      const trimmed = line.trimStart();
      return (
        trimmed.startsWith(`${field} `) ||
        trimmed.startsWith(`${field}=`) ||
        trimmed.startsWith(`[${field}]`) ||
        trimmed.startsWith(`[[${field}]]`) ||
        trimmed.startsWith(`[${field}.`)
      );
    });
    return index < 0 ? null : index + 1;
  };
}

/**
 * A JSON Lines file read line by line against the schema of one line. Every
 * line holds one JSON object, and the file ends with a newline.
 */
export function readJsonLines<T extends z.ZodTypeAny>(
  text: string,
  schema: T,
): ReadResult<z.output<T>[]> {
  const issues = encodingIssues(text);
  if (issues.length > 0) return { ok: false, issues };
  const values: z.output<T>[] = [];
  text
    .slice(0, -1)
    .split("\n")
    .forEach((line, index) => {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        issues.push({
          line: index + 1,
          field: null,
          message: "the line is not one JSON object",
        });
        return;
      }
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        values.push(parsed.data as z.output<T>);
        return;
      }
      for (const issue of schemaIssues(parsed.error)) {
        issues.push({ ...issue, line: index + 1 });
      }
    });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: values };
}
