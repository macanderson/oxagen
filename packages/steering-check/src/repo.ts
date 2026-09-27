// repo.ts: reading a steering tree for the checks. Every function here is
// pure: it takes text and returns values, lines, and fields.
import {
  classifySteeringRepoPath,
  parseFrontmatter,
  readTomlFile,
  recordLineageFromPath,
  splitRecordFile,
  steeringRecordSchema,
  type SteeringRecord,
  type SteeringRepoFileKind,
  WORKSPACE_TOML_PATH,
  workspaceSchema,
  TOOL_SERVERS_DIR,
  SERVER_TOML_NAME,
  TOOLS_TOML_NAME,
  TOOLS_LOCK_NAME,
} from "@oxagen/oxagen/steering-repo";
import { parse as parseToml } from "smol-toml";
import type { SteeringTree } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

// ── Records ──────────────────────────────────────────────────────────────────

/** A record file as the checks read it. `record` is null when the schema refuses it. */
export interface RecordFile {
  path: string;
  kind: "record" | "skill-record";
  /** The frontmatter as YAML gives it, before the schema reads it. */
  raw: Record<string, unknown>;
  key_lines: ReadonlyMap<string, number>;
  record: SteeringRecord | null;
  body: string;
  body_line: number;
  /** The lineage the frontmatter declares, or the one the path names. */
  lineage: string | null;
}

function isRecordKind(kind: SteeringRepoFileKind): kind is "record" | "skill-record" {
  return kind === "record" || kind === "skill-record";
}

/** Read one record file, or null when its fences or its YAML do not parse. */
export function readRecordFile(path: string, text: string): RecordFile | null {
  const kind = classifySteeringRepoPath(path);
  if (!isRecordKind(kind)) return null;
  const split = splitRecordFile(text);
  if (!split.ok) return null;
  const parsed = parseFrontmatter(split.parts.frontmatter);
  if (!parsed.ok) return null;
  const { value, key_lines } = parsed.frontmatter;
  const typed = steeringRecordSchema.safeParse(value);
  const declared = value.lineage;
  return {
    path,
    kind,
    raw: value,
    key_lines,
    record: typed.success && split.parts.body.trim() !== "" ? typed.data : null,
    body: split.parts.body,
    body_line: split.parts.body_line,
    lineage: isString(declared) ? declared : recordLineageFromPath(path),
  };
}

/** Every record file in a tree that parses, in path order. */
export function recordFiles(tree: SteeringTree): RecordFile[] {
  const files: RecordFile[] = [];
  for (const path of [...tree.keys()].sort()) {
    const file = readRecordFile(path, tree.get(path) as string);
    if (file) files.push(file);
  }
  return files;
}

/** The line of item `n` (0-based) of a YAML block list whose key is on `keyLine`. */
export function yamlItemLine(text: string, keyLine: number, n: number): number {
  const lines = text.split("\n");
  if (/\[\s*$|\[.*\]/.test(lines[keyLine - 1] ?? "")) return keyLine;
  let seen = -1;
  for (let index = keyLine; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (!/^\s+-\s/.test(line)) {
      if (/^\S/.test(line)) break;
      continue;
    }
    seen += 1;
    if (seen === n) return index + 1;
  }
  return keyLine;
}

/** The line a record's field sits on: a top-level key, or an item of a list key such as `repos.0`. */
export function recordFieldLine(file: RecordFile, text: string, field: string): number | null {
  const [top, index] = field.split(".");
  const line = file.key_lines.get(top as string);
  if (line === undefined) return null;
  if (index !== undefined && /^\d+$/.test(index)) return yamlItemLine(text, line, Number(index));
  return line;
}

/** The lines of the body, counted from the file's first line, where `index` falls. */
export function bodyOffsetLine(file: RecordFile, index: number): number {
  return file.body_line + (file.body.slice(0, index).match(/\n/g)?.length ?? 0);
}

// ── TOML ─────────────────────────────────────────────────────────────────────

const TABLE_ARRAY = /^\s*\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]/;
const TABLE = /^\s*\[\s*([A-Za-z0-9_."-]+)\s*\]/;
const KEY = /^\s*("[^"]+"|[A-Za-z0-9_-]+)\s*=/;

/**
 * The line of every field in a TOML file, by its dot-joined path: a table
 * header, a key, or `reviewers.0.group` for a key in the first `[[reviewers]]`.
 * A multi-line array's items get `tools.0`, `tools.1`, and so on.
 */
export function tomlFieldLines(text: string): Map<string, number> {
  const lines = text.split("\n");
  const found = new Map<string, number>();
  const counts = new Map<string, number>();
  let table = "";
  let array: { field: string; n: number } | null = null;
  const set = (field: string, line: number) => {
    if (!found.has(field)) found.set(field, line);
  };
  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, "");
    const number = index + 1;
    if (array) {
      if (/^\s*\]/.test(line)) {
        array = null;
        return;
      }
      if (/^\s*["'A-Za-z0-9{]/.test(line)) {
        set(`${array.field}.${array.n}`, number);
        array.n += 1;
      }
      return;
    }
    const many = TABLE_ARRAY.exec(line);
    if (many) {
      const name = many[1] as string;
      const n = counts.get(name) ?? 0;
      counts.set(name, n + 1);
      table = `${name}.${n}`;
      set(name, number);
      set(table, number);
      return;
    }
    const one = TABLE.exec(line);
    if (one) {
      table = (one[1] as string).replace(/"/g, "");
      set(table, number);
      return;
    }
    const key = KEY.exec(line);
    if (key) {
      const name = (key[1] as string).replace(/"/g, "");
      const field = table === "" ? name : `${table}.${name}`;
      set(field, number);
      if (/=\s*\[\s*$/.test(line)) array = { field, n: 0 };
    }
  });
  return found;
}

/** The line of a TOML field, or of the nearest table that holds it. */
export function tomlLine(text: string, field: string): number | null {
  const lines = tomlFieldLines(text);
  const parts = field.split(".");
  for (let end = parts.length; end > 0; end -= 1) {
    const line = lines.get(parts.slice(0, end).join("."));
    if (line !== undefined) return line;
  }
  return null;
}

/** A TOML file parsed with no schema, or null when it is not TOML. */
export function parseTomlLoose(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const value: unknown = parseToml(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** A JSON file parsed with no schema, or null when it is not JSON. */
export function parseJsonLoose(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// ── Workspace ────────────────────────────────────────────────────────────────

/** The code repositories workspace.toml links, or null when the file is missing or unreadable. */
export function workspaceRepositories(tree: SteeringTree): string[] | null {
  const text = tree.get(WORKSPACE_TOML_PATH);
  if (text === undefined) return null;
  const read = readTomlFile(text, "workspace/v1", workspaceSchema);
  if (!read.ok) return null;
  return (read.value.repositories ?? []).map(({ url }) => url);
}

// ── Tool servers ─────────────────────────────────────────────────────────────

/** One server folder under tools/servers/, read loosely. */
export interface ServerFolder {
  name: string;
  server: Record<string, unknown> | null;
  /** The keys under `[tools]` in tools.toml, with each key's table. */
  tools: Map<string, Record<string, unknown>>;
  /** The keys under `tools` in tools.lock.json, with each locked entry. */
  locked: Map<string, Record<string, unknown>>;
}

function entries(value: unknown): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  if (!isRecord(value)) return found;
  for (const [key, entry] of Object.entries(value)) {
    if (isRecord(entry)) found.set(key, entry);
  }
  return found;
}

/** Every server folder in a tree, by name. */
export function serverFolders(tree: SteeringTree): Map<string, ServerFolder> {
  const names = new Set<string>();
  for (const path of tree.keys()) {
    const parts = path.split("/");
    if (path.startsWith(`${TOOL_SERVERS_DIR}/`) && parts.length >= 4) names.add(parts[2] as string);
  }
  const folders = new Map<string, ServerFolder>();
  for (const name of [...names].sort()) {
    const dir = `${TOOL_SERVERS_DIR}/${name}`;
    const tools = parseTomlLoose(tree.get(`${dir}/${TOOLS_TOML_NAME}`));
    const lock = parseJsonLoose(tree.get(`${dir}/${TOOLS_LOCK_NAME}`));
    folders.set(name, {
      name,
      server: parseTomlLoose(tree.get(`${dir}/${SERVER_TOML_NAME}`)),
      tools: entries(tools?.tools),
      locked: entries(lock?.tools),
    });
  }
  return folders;
}

/** The paths a change touches: text that differs, and paths the head drops. */
export function changedPaths(
  head: SteeringTree,
  base: SteeringTree | null,
): { changed: Set<string>; removed: Set<string> } {
  const changed = new Set<string>();
  const removed = new Set<string>();
  if (base === null) return { changed: new Set(head.keys()), removed };
  for (const [path, text] of head) {
    if (base.get(path) !== text) changed.add(path);
  }
  for (const path of base.keys()) {
    if (!head.has(path)) removed.add(path);
  }
  return { changed, removed };
}

/** The first line where two texts differ, 1-based. */
export function firstDifferingLine(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = Math.max(a.length, b.length);
  for (let index = 0; index < n; index += 1) {
    if (a[index] !== b[index]) return index + 1;
  }
  return 1;
}

/** A number with thousands separators, as the human format prints it. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}
