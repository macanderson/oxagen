// schema.ts: each file against its JSON Schema, a record's name and folder
// against its lineage, and the size warnings the Tokens section sets.
import {
  agentSchema,
  ALWAYS_ON_BODY_WORDS_WARN,
  classifySteeringRepoPath,
  encodingIssues,
  type FileIssue,
  FOLDER_FILES_WARN,
  governanceSchema,
  isAlwaysOn,
  readSteeringRecord,
  readTomlFile,
  recordStatement,
  SKILL_FILE_NAME,
  SKILL_LINES_WARN,
  SKILLS_DIR,
  type SteeringRepoFileKind,
  toolbeltSchema,
  workspaceSchema,
} from "@oxagen/oxagen/steering-repo";
import { parse as parseToml } from "smol-toml";
import { finder, sentence, type FindingInit, type TreeCheck } from "../finding";
import { readRecordFile, recordFieldLine, tomlLine, type RecordFile } from "../repo";
import type { Finding, ServerReaders, SteeringTree } from "../types";

const find = finder("schema");

type FileFamily = "record" | "toml";

interface RuleText {
  expected: string;
  fix: string;
}

const FIXED: Readonly<Record<string, RuleText>> = {
  "toml-syntax": {
    expected: "A file TOML can parse.",
    fix: "Correct the syntax on this line.",
  },
  encoding: {
    expected: "UTF-8 with no byte-order mark, LF line endings, and a newline at the end.",
    fix: "Save the file as UTF-8 with LF line endings and a newline at the end.",
  },
  "body-required": {
    expected: "A statement below the frontmatter.",
    fix: "Write the statement below the closing --- line.",
  },
  "record-fences": {
    expected: "A --- line first, and a --- line after the last field.",
    fix: "Put --- on the first line and on the line after the last field.",
  },
  "strict-yaml": {
    expected: "Plain YAML: mappings, lists, and strings, with no anchors, aliases, or tags.",
    fix: "Write each value out in full and remove anchors, aliases, and tags.",
  },
  "unknown-field": {
    expected: "Only the fields steering-record/v1 defines.",
    fix: "Remove the field or correct its spelling.",
  },
  "unknown-key": {
    expected: "Only the keys the file's schema defines.",
    fix: "Remove the key or correct its spelling.",
  },
  "auto-merge-solo-only": {
    expected: "memory.auto_merge = false unless mode is solo.",
    fix: 'Set memory.auto_merge = false, or set mode = "solo".',
  },
  "constraint-effect-required": {
    expected: "effect: require or effect: forbid on a constraint.",
    fix: "Add effect: require or effect: forbid, or change the kind.",
  },
  "skill-description-required": {
    expected: "A description on every skill, of at most 1,024 characters.",
    fix: "Add a description that says when to use the skill.",
  },
  "description-length": {
    expected: "A description of at most 200 characters, or 1,024 for a skill.",
    fix: "Shorten the description to one sentence.",
  },
  "memories-required": {
    expected: "At least one entry in provenance.memories when provenance.source is run.",
    fix: "List the memories the record cites, or set provenance.source to where the record came from.",
  },
  "memory-entry-keys": {
    expected: "Each memory entry holds agent, run, statement, and evidence, and nothing else.",
    fix: "Give the entry exactly agent, run, statement, and evidence.",
  },
  "memory-statement-required": {
    expected: "A statement in every memory entry.",
    fix: "Copy the memory's statement into the entry.",
  },
  "repos-required": {
    expected: "At least one code repository in repos when scope is repository.",
    fix: "List the code repositories in repos, or change the scope.",
  },
  "tool-target": {
    expected: "<server>__<tool>, or <server>__* for every tool of one server.",
    fix: "Write the tool as <server>__<tool>, with two underscores.",
  },
  "embeddings-custom-endpoint": {
    expected: "url and model only when provider is custom, and both when it is.",
    fix: 'Set provider = "custom" with a url and a model, or remove url, model, and credential.',
  },
  "stella-archive-days": {
    expected: "A whole number of days from 1 to 365.",
    fix: "Set archive_after_days to a whole number from 1 to 365, or remove it for 7.",
  },
  "file-schema": {
    expected: "A file that matches its JSON Schema.",
    fix: "Correct the field to match the schema.",
  },
};

function lastSegment(field: string): string {
  const parts = field.split(".");
  return parts[parts.length - 1] as string;
}

function issueMessage(issue: FileIssue): string {
  const message = sentence(issue.message);
  if (issue.field === null) return message;
  const name = lastSegment(issue.field);
  return message.includes(name) ? message : `${issue.field}: ${message}`;
}

/** The rule a reader's issue breaks, or null when another check reports it. */
function ruleOf(issue: FileIssue, family: FileFamily, raw: Record<string, unknown> | null): string | null {
  const { field, message } = issue;
  if (issue.line === 1 && message.startsWith("the first line must be")) return "schema-directive";
  if (message.startsWith("the file is not TOML")) return "toml-syntax";
  if (
    message === "the file is empty" ||
    message.includes("byte-order mark") ||
    message.includes("CRLF") ||
    message.includes("does not end with a newline")
  ) {
    return "encoding";
  }
  if (message.startsWith("the body is empty")) return "body-required";
  if (message.startsWith("a record starts with ---") || message.startsWith("the frontmatter has no closing ---")) {
    return "record-fences";
  }
  if (field === "provenance.memories") return "memories-required";
  if (field !== null && /^provenance\.memories\.\d+\.statement$/.test(field)) return "memory-statement-required";
  if (field !== null && /^provenance\.memories\.\d+/.test(field)) return "memory-entry-keys";
  if (message.includes("is not a known field")) return family === "record" ? "unknown-field" : "unknown-key";
  if (field === "memory.auto_merge") return "auto-merge-solo-only";
  if (field === "effect" && family === "record") {
    const effect = raw?.effect;
    if (effect === "allow") return null;
    return effect === undefined ? "constraint-effect-required" : "enum-value";
  }
  if (field === "description" && family === "record") {
    if (message.includes("is required")) return "skill-description-required";
    if (message.includes("at most")) return "description-length";
  }
  if (field !== null && field.startsWith("embeddings.")) return "embeddings-custom-endpoint";
  if (field === "repos") return "repos-required";
  if (field !== null && /^tools\.\d+$/.test(field)) return "tool-target";
  if (field === "stella.archive_after_days") return "stella-archive-days";
  if (message.startsWith("Invalid enum value")) return "enum-value";
  if (family === "record" && field === null) return "strict-yaml";
  return "file-schema";
}

function ruleText(rule: string, issue: FileIssue): RuleText {
  if (rule === "schema-directive") {
    const directive = issue.message.replace("the first line must be ", "");
    return { expected: directive, fix: "Make the directive the file's first line." };
  }
  if (rule === "enum-value") {
    const expected = /Expected (.+), received/.exec(issue.message);
    return {
      expected: expected ? `One of ${expected[1] as string}.` : "One of the values the schema lists.",
      fix: "Use one of the values the schema lists.",
    };
  }
  return FIXED[rule] ?? (FIXED["file-schema"] as RuleText);
}

function fromIssues(
  path: string,
  issues: readonly FileIssue[],
  family: FileFamily,
  raw: Record<string, unknown> | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const issue of issues) {
    const rule = ruleOf(issue, family, raw);
    if (rule === null) continue;
    findings.push(
      find({
        rule,
        path,
        line: issue.line,
        field: issue.field,
        message: issueMessage(issue),
        ...ruleText(rule, issue),
      }),
    );
  }
  return findings;
}

function fileStem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.slice(0, name.lastIndexOf("."));
}

/** The file named for the `name` its TOML declares, as agents/ and tools/toolbelts/ require. */
function namedForName(path: string, text: string, name: string): Finding[] {
  const stem = fileStem(path);
  if (name === stem) return [];
  return [
    find({
      rule: "file-named-for-name",
      path,
      line: tomlLine(text, "name"),
      field: "name",
      message: `The file is named ${stem}, but its name is ${name}.`,
      expected: "A file named for the name it declares.",
      fix: `Rename the file to ${name}.toml, or set name = "${stem}".`,
    }),
  ];
}

function readToml(path: string, text: string, kind: SteeringRepoFileKind): Finding[] {
  switch (kind) {
    case "workspace": {
      const read = readTomlFile(text, "workspace/v1", workspaceSchema);
      return read.ok ? [] : fromIssues(path, read.issues, "toml", null);
    }
    case "governance": {
      const read = readTomlFile(text, "governance/v1", governanceSchema);
      return read.ok ? [] : fromIssues(path, read.issues, "toml", null);
    }
    case "agent": {
      const read = readTomlFile(text, "agent/v1", agentSchema);
      return read.ok ? namedForName(path, text, read.value.name) : fromIssues(path, read.issues, "toml", null);
    }
    case "toolbelt": {
      const read = readTomlFile(text, "toolbelt/v1", toolbeltSchema);
      return read.ok ? namedForName(path, text, read.value.name) : fromIssues(path, read.issues, "toml", null);
    }
    default:
      return [];
  }
}

/** A server file: the injected reader, or the encoding rules and the TOML syntax without one. */
function readServerFile(
  path: string,
  text: string,
  reader: ServerReaders["server"] | undefined,
): Finding[] {
  if (reader) {
    const outcome = reader(text);
    return outcome.ok ? [] : fromIssues(path, outcome.issues, "toml", null);
  }
  const encoding = encodingIssues(text);
  if (encoding.length > 0) return fromIssues(path, encoding, "toml", null);
  try {
    parseToml(text);
    return [];
  } catch (error) {
    const { line, message } = error as { line?: number; message: string };
    const issue: FileIssue = {
      line: line ?? null,
      field: null,
      message: `the file is not TOML: ${message.split("\n", 1)[0] as string}`,
    };
    return fromIssues(path, [issue], "toml", null);
  }
}

function lineageLine(file: RecordFile, text: string): number | null {
  return recordFieldLine(file, text, "lineage");
}

/** A record's file or folder against its lineage, and a skill's shape. */
function recordShape(file: RecordFile, text: string): Finding[] {
  const findings: Finding[] = [];
  const lineage = file.raw.lineage;
  if (typeof lineage !== "string") return findings;
  const parts = file.path.split("/");
  if (file.kind === "record" && fileStem(file.path) !== lineage) {
    findings.push(
      find({
        rule: "file-named-for-lineage",
        path: file.path,
        line: lineageLine(file, text),
        field: "lineage",
        message: `The file is named ${fileStem(file.path)}.md, but its lineage is ${lineage}.`,
        expected: "A record file named <lineage>.md.",
        fix: `Rename the file to ${lineage}.md, or correct the lineage.`,
      }),
    );
  }
  if (file.kind === "skill-record" && parts[2] !== lineage) {
    findings.push(
      find({
        rule: "skill-folder-named-for-lineage",
        path: file.path,
        line: lineageLine(file, text),
        field: "lineage",
        message: `The skill's folder is named ${parts[2] as string}, but its lineage is ${lineage}.`,
        expected: `A skill at ${SKILLS_DIR}/<lineage>/${SKILL_FILE_NAME}.`,
        fix: `Rename the folder to ${lineage}, or correct the lineage.`,
      }),
    );
  }
  const kind = file.raw.kind;
  if (file.kind === "record" && kind === "skill") {
    findings.push(
      find({
        rule: "skill-shape",
        path: file.path,
        line: recordFieldLine(file, text, "kind"),
        field: "kind",
        message: `A skill must live in its own folder under ${SKILLS_DIR}.`,
        expected: `A skill at ${SKILLS_DIR}/<lineage>/${SKILL_FILE_NAME}.`,
        fix: `Move the file to ${SKILLS_DIR}/${lineage}/${SKILL_FILE_NAME}, or change the kind.`,
      }),
    );
  }
  if (file.kind === "skill-record" && typeof kind === "string" && kind !== "skill") {
    findings.push(
      find({
        rule: "skill-shape",
        path: file.path,
        line: recordFieldLine(file, text, "kind"),
        field: "kind",
        message: `A ${SKILL_FILE_NAME} must have kind: skill, but this one has kind: ${kind}.`,
        expected: `kind: skill in every ${SKILL_FILE_NAME}.`,
        fix: `Set kind: skill, or move the record out of ${SKILLS_DIR}.`,
      }),
    );
  }
  return findings;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

function readRecord(path: string, text: string): Finding[] {
  const read = readSteeringRecord(text);
  const file = readRecordFile(path, text);
  const findings = read.ok ? [] : fromIssues(path, read.issues, "record", file?.raw ?? null);
  if (file) findings.push(...recordShape(file, text));
  if (file?.record && isAlwaysOn(file.record)) {
    const words = wordCount(recordStatement(file.body));
    if (words > ALWAYS_ON_BODY_WORDS_WARN) {
      findings.push(
        find({
          rule: "always-on-words",
          severity: "warning",
          path,
          line: file.body_line,
          field: null,
          message: `The always-on statement is longer than ${ALWAYS_ON_BODY_WORDS_WARN} words.`,
          expected: `An always-on statement of at most ${ALWAYS_ON_BODY_WORDS_WARN} words.`,
          fix: "Shorten the statement, move the detail into a skill, or set force: may so it loads when it fits.",
          detail: { words },
        }),
      );
    }
  }
  if (classifySteeringRepoPath(path) === "skill-record" && lineCount(text) > SKILL_LINES_WARN) {
    findings.push(
      find({
        rule: "skill-lines",
        severity: "warning",
        path,
        line: null,
        field: null,
        message: `The ${SKILL_FILE_NAME} is longer than ${SKILL_LINES_WARN} lines.`,
        expected: `A ${SKILL_FILE_NAME} of at most ${SKILL_LINES_WARN} lines.`,
        fix: `Move the detail into files in the skill's folder and link them from ${SKILL_FILE_NAME}.`,
        detail: { lines: lineCount(text) },
      }),
    );
  }
  return findings;
}

/** Folders that hold more files than the warning allows, directly. */
function folderFindings(tree: SteeringTree): Finding[] {
  const counts = new Map<string, number>();
  for (const path of tree.keys()) {
    const cut = path.lastIndexOf("/");
    const folder = cut < 0 ? "." : path.slice(0, cut);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  const findings: Finding[] = [];
  for (const [folder, files] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (files <= FOLDER_FILES_WARN) continue;
    const init: FindingInit = {
      rule: "folder-files",
      severity: "warning",
      path: folder,
      line: null,
      field: null,
      message: `The folder holds more than ${FOLDER_FILES_WARN} files.`,
      expected: `At most ${FOLDER_FILES_WARN} files in one folder.`,
      fix: "Split the files into subfolders by team or topic.",
      detail: { files },
    };
    findings.push(find(init));
  }
  return findings;
}

export const schemaCheck: TreeCheck = (tree, env) => {
  const findings: Finding[] = [];
  for (const [path, text] of tree) {
    const kind = classifySteeringRepoPath(path);
    switch (kind) {
      case "record":
      case "skill-record":
        findings.push(...readRecord(path, text));
        break;
      case "workspace":
      case "governance":
      case "agent":
      case "toolbelt":
        findings.push(...readToml(path, text, kind));
        break;
      case "server":
        findings.push(...readServerFile(path, text, env.servers?.server));
        break;
      case "server-tools":
        findings.push(...readServerFile(path, text, env.servers?.tools));
        break;
      default:
        break;
    }
  }
  findings.push(...folderFindings(tree));
  return findings;
};
