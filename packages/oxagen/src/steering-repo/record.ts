// record.ts: `steering-record/v1`, a steering record's YAML frontmatter
// (oxagen-steering-record-spec, Frontmatter fields and JSON Schema), with the
// four fields the steering repo spec adds before v1 ships: `repos`, `tools`,
// `skills`, and `description` on every kind (steering-repo-spec, Record
// changes). Targets combine: a record reaches a request only when every
// target it names matches.
//
// A record file is `---`, a strict YAML frontmatter, `---`, and a CommonMark
// body. This module reads one, and computes the `id` and `hash` Oxagen stamps
// into it when its steering PR merges.
import {
  isMap,
  isScalar,
  LineCounter,
  parseAllDocuments,
  visit,
  type Document,
} from "yaml";
import { z } from "zod";
import { jcsBytes, sha256Digest } from "@oxagen/run-evidence";
import { CONTEXT_RECORD_LABEL_MAX } from "../context-record-label";
import {
  lineageSchema,
  recordIdSchema,
  repoRefSchema,
  sha256Schema,
  toolTargetSchema,
} from "./common";
import { encodingIssues, schemaIssues, type FileIssue } from "./files";
import { uniqueArray, withRules } from "./json-schema";
import { DESCRIPTION_MAX, SKILL_DESCRIPTION_MAX } from "./tokens";

export const RECORD_KINDS = [
  "business-rule",
  "code-rule",
  "constraint",
  "procedure",
  "skill",
  "fact",
  "preference",
  "memory",
] as const;
export const recordKindSchema = z.enum(RECORD_KINDS);
export type RecordKind = z.output<typeof recordKindSchema>;

/** `must` and `should` reach every request; `may` and `info` reach one they fit. */
export const recordForceSchema = z.enum(["must", "should", "may", "info"]);
export type RecordForce = z.output<typeof recordForceSchema>;

/** A constraint's effect. `allow` does not exist: a record never grants authority. */
export const recordEffectSchema = z.enum(["require", "forbid"]);
export type RecordEffect = z.output<typeof recordEffectSchema>;

export const recordScopeSchema = z.enum([
  "workspace",
  "repository",
  "organization",
]);
export type RecordScope = z.output<typeof recordScopeSchema>;

export const recordStatusSchema = z.enum(["active", "archived"]);
export const recordOriginSchema = z.enum(["user", "inferred"]);

/** When a record reaches a request. Unset, it follows the record's force. */
export const recordLoadSchema = z.enum(["always", "match", "relevant", "mention"]);
export type RecordLoad = z.output<typeof recordLoadSchema>;

export const recordProvenanceSchema = z
  .object({
    source: z.enum(["proposal", "run", "import"]),
    uri: z.string(),
  })
  .strict();

/** The frontmatter fields, in the order Oxagen writes them. */
const recordShape = z
  .object({
    schema: z.literal("steering-record/v1"),
    lineage: lineageSchema,
    label: z.string().min(1).max(CONTEXT_RECORD_LABEL_MAX),
    description: z
      .string()
      .max(SKILL_DESCRIPTION_MAX)
      .optional()
      .describe(
        "One sentence, the record's line in the index an agent reads. At most 200 characters, or 1,024 for a skill.",
      ),
    kind: recordKindSchema,
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional()
      .describe("A skill's folder name, as harnesses expect."),
    effect: recordEffectSchema.optional(),
    force: recordForceSchema,
    scope: recordScopeSchema,
    repos: uniqueArray(repoRefSchema, "repos", 1)
      .optional()
      .describe(
        "The code repositories a run must be working in for the record to reach it. Required when scope is repository.",
      ),
    tools: uniqueArray(toolTargetSchema, "tools", 1)
      .optional()
      .describe(
        "Tool names, or <server>__* prefixes. The record reaches a request only when the run's toolbelt holds a match.",
      ),
    skills: uniqueArray(lineageSchema, "skills", 1)
      .optional()
      .describe(
        "Skill lineages. The record reaches a request only when the request's context.skill is on the list. A record cannot target a named agent.",
      ),
    applies_to: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe("Path globs the record is about. load: match reads them."),
    load: recordLoadSchema.optional(),
    status: recordStatusSchema,
    origin: recordOriginSchema,
    provenance: recordProvenanceSchema,
    id: recordIdSchema.optional().describe("Written by Oxagen on merge."),
    hash: sha256Schema.optional().describe("Written by Oxagen on merge."),
  })
  .strict();

/** Every frontmatter field, in the order Oxagen writes them. */
export const STEERING_RECORD_FIELDS = Object.keys(recordShape.shape) as Array<
  keyof z.output<typeof recordShape>
>;

export const steeringRecordSchema = withRules(recordShape, [
  { kind: "require", when: { field: "kind", is: "constraint" }, fields: ["effect"] },
  {
    kind: "require",
    when: { field: "kind", is: "skill" },
    fields: ["name", "description"],
  },
  {
    kind: "require",
    when: { field: "scope", is: "repository" },
    fields: ["repos"],
  },
  {
    kind: "max_length",
    when: { field: "kind", isNot: "skill" },
    field: "description",
    max: DESCRIPTION_MAX,
  },
]);
export type SteeringRecord = z.output<typeof steeringRecordSchema>;

/** The load a record takes: its own, or `always` for `must` and `should` and `relevant` for the rest. */
export function effectiveLoad(record: SteeringRecord): RecordLoad {
  if (record.load) return record.load;
  return record.force === "must" || record.force === "should"
    ? "always"
    : "relevant";
}

/** Does the record reach every request, and so count against the always-on budget? */
export function isAlwaysOn(record: SteeringRecord): boolean {
  return (
    record.status === "active" &&
    (record.force === "must" || record.force === "should") &&
    effectiveLoad(record) === "always"
  );
}

// ── Reading a record file ────────────────────────────────────────────────────

/** A record file split at its fences. `body_line` is the file line the body starts on. */
export interface RecordFileParts {
  frontmatter: string;
  body: string;
  body_line: number;
}

/** Split a record file into its frontmatter and body at the two `---` lines. */
export function splitRecordFile(
  text: string,
): { ok: true; parts: RecordFileParts } | { ok: false; issue: FileIssue } {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    return {
      ok: false,
      issue: {
        line: 1,
        field: null,
        message: "a record starts with --- on its own line",
      },
    };
  }
  const close = lines.indexOf("---", 1);
  if (close < 0) {
    return {
      ok: false,
      issue: {
        line: 1,
        field: null,
        message: "the frontmatter has no closing --- line",
      },
    };
  }
  return {
    ok: true,
    parts: {
      frontmatter: lines.slice(1, close).join("\n"),
      body: lines.slice(close + 1).join("\n"),
      body_line: close + 2,
    },
  };
}

/** YAML in the strict subset: plain mappings, lists, and strings, one document. */
export interface ParsedFrontmatter {
  value: Record<string, unknown>;
  /** The file line of each top-level key. */
  key_lines: Map<string, number>;
}

function strictSubsetIssues(
  doc: Document.Parsed,
  lineOf: (offset: number) => number,
): FileIssue[] {
  const issues: FileIssue[] = [];
  const at = (range: readonly number[] | null | undefined): number | null =>
    range ? lineOf(range[0] as number) : null;
  visit(doc, {
    Alias(_key, node) {
      issues.push({
        line: at(node.range),
        field: null,
        message: "the frontmatter uses a YAML alias. Write the value out.",
      });
    },
    Node(_key, node) {
      if (node.anchor) {
        issues.push({
          line: at(node.range),
          field: null,
          message: "the frontmatter uses a YAML anchor. Write the value out.",
        });
      }
      if (node.tag) {
        issues.push({
          line: at(node.range),
          field: null,
          message: `the frontmatter uses the YAML tag ${node.tag}. Remove it.`,
        });
      }
    },
  });
  return issues;
}

/**
 * Parse a record's frontmatter. `firstLine` is the file line the frontmatter
 * starts on, 2 in a record file. Anchors, aliases, tags, duplicate keys, and
 * a second document are refused.
 */
export function parseFrontmatter(
  yamlText: string,
  firstLine = 2,
): { ok: true; frontmatter: ParsedFrontmatter } | { ok: false; issues: FileIssue[] } {
  const counter = new LineCounter();
  const lineOf = (offset: number) => counter.linePos(offset).line + firstLine - 1;
  const docs = parseAllDocuments(yamlText, { lineCounter: counter, uniqueKeys: true });
  const doc = docs[0];
  if (docs.length !== 1 || doc === undefined) {
    return {
      ok: false,
      issues: [
        {
          line: firstLine,
          field: null,
          message:
            docs.length === 0
              ? "the frontmatter is empty"
              : "the frontmatter holds more than one YAML document",
        },
      ],
    };
  }
  const issues: FileIssue[] = doc.errors.map((error) => ({
    line: error.linePos ? error.linePos[0].line + firstLine - 1 : null,
    field: null,
    message: error.message.split("\n", 1)[0] as string,
  }));
  issues.push(...strictSubsetIssues(doc, lineOf));
  if (issues.length > 0) return { ok: false, issues };
  if (!isMap(doc.contents)) {
    return {
      ok: false,
      issues: [
        {
          line: firstLine,
          field: null,
          message: "the frontmatter is not a mapping of fields",
        },
      ],
    };
  }
  const key_lines = new Map<string, number>();
  for (const pair of doc.contents.items) {
    if (isScalar(pair.key) && pair.key.range) {
      key_lines.set(String(pair.key.value), lineOf(pair.key.range[0]));
    }
  }
  return {
    ok: true,
    frontmatter: {
      value: doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>,
      key_lines,
    },
  };
}

/** A record file read in full: the typed frontmatter and the body. */
export type RecordReadResult =
  | { ok: true; record: SteeringRecord; body: string; body_line: number }
  | { ok: false; issues: FileIssue[] };

/**
 * Read a record file: the encoding rules, the fences, the strict YAML
 * subset, the schema, and a body with at least one line of text.
 */
export function readSteeringRecord(text: string): RecordReadResult {
  const encoding = encodingIssues(text);
  if (encoding.length > 0) return { ok: false, issues: encoding };
  const split = splitRecordFile(text);
  if (!split.ok) return { ok: false, issues: [split.issue] };
  const { frontmatter, body, body_line } = split.parts;
  const parsed = parseFrontmatter(frontmatter);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const { value, key_lines } = parsed.frontmatter;
  const result = steeringRecordSchema.safeParse(value);
  const issues: FileIssue[] = result.success
    ? []
    : schemaIssues(result.error, (field) => key_lines.get(field) ?? null);
  if (body.trim() === "") {
    issues.push({
      line: body_line,
      field: null,
      message: "the body is empty. Write the statement below the frontmatter.",
    });
  }
  if (!result.success || issues.length > 0) return { ok: false, issues };
  return { ok: true, record: result.data, body, body_line };
}

// ── Identity ─────────────────────────────────────────────────────────────────
//
// A record's id and hash come from what it says, never from the file's bytes
// (oxagen-steering-record-spec, Id and hash). The preimage is the frontmatter
// without `id`, `hash`, and `label`, plus the body as `statement`. Pass 1
// hashes it and the first 12 hex characters make the id. Pass 2 hashes it
// again with the id in it.

/** The body as the preimage holds it: LF line endings, no leading or trailing blank lines. */
export function recordStatement(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/** The lineage as the id spells it: lowercase, and anything but a letter or digit as `_`. */
export function recordSlug(lineage: string): string {
  return lineage.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

/** The fields and body that name one version of a record. */
export function recordPreimage(
  frontmatter: Record<string, unknown>,
  body: string,
): Record<string, unknown> {
  const fields = Object.entries(frontmatter).filter(
    ([key, value]) =>
      key !== "id" && key !== "hash" && key !== "label" && value != null,
  );
  return { ...Object.fromEntries(fields), statement: recordStatement(body) };
}

function digest(value: unknown): string {
  return sha256Digest(jcsBytes(value));
}

/** The `id` and `hash` Oxagen writes into a record when its steering PR merges. */
export function stampRecord(
  frontmatter: Record<string, unknown>,
  body: string,
): { id: string; hash: string } {
  const preimage = recordPreimage(frontmatter, body);
  const seed = digest(preimage);
  const id = `rec_${recordSlug(String(frontmatter.lineage))}_${seed.slice(7, 19)}`;
  return { id, hash: digest({ ...preimage, id }) };
}
