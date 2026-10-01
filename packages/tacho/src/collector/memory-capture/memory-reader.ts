/**
 * The memory reader: finds the memory files a harness keeps on this machine
 * and hands each new one to `send`, which uploads it to Oxagen as a
 * `local_gateway` memory (memory/v1). Claude Code keeps one memory per file
 * in `~/.claude/projects/<project>/memory/`, with `MEMORY.md` as the index.
 * The file's frontmatter `name`, `description`, and `type` (top-level or
 * under `metadata:`) travel with it as the memory's label, summary, and type.
 *
 * The reader keeps, for each file, a digest of what it last sent: the
 * statement and the three frontmatter fields. A scan sends only the files
 * that are new or changed, so a frontmatter-only edit is sent too. A file
 * edited back to text it held before is sent again, because the API keeps
 * one waiting memory per file and replaces its text with each new send
 * (ADR-238). Two files with the same text are two sources, and each is sent.
 * A daemon restart sends every memory again, and the API's dedupe key makes
 * the repeat a no-op.
 *
 * A scan also lists every memory file it found, one list per location, for
 * `record_tacho_memory_uses`, which retires the memories whose files a scan
 * no longer finds (ADR-245). The lists come back only from a complete scan:
 * every folder listed, where a missing folder counts as empty, and no send
 * failed. A partial list would retire memories whose files still exist.
 * After a complete scan the reader forgets each file the scan did not find,
 * so a deleted file that comes back unchanged is sent again and its memory
 * returns.
 */
import { join, sep } from "node:path";
import { digestBytes, type Sha256Digest } from "../../digest";
import type { TachoHarness } from "../../wire";

/** The longest statement memory/v1 accepts. */
export const MEMORY_STATEMENT_MAX_CHARS = 2_000;
/** The longest label the ingest contract accepts. */
export const MEMORY_LABEL_MAX_CHARS = 200;
/** The longest summary the ingest contract accepts. */
export const MEMORY_SUMMARY_MAX_CHARS = 1_000;
/** A memory type the ingest contract accepts, such as Claude Code's `feedback`. */
export const MEMORY_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** One memory file, as the reader sends it. */
export interface LocalMemoryEntry {
  harness: TachoHarness;
  /** The memory file's path. */
  path: string;
  /** The file's body without its frontmatter, trimmed and clipped. */
  statement: string;
  /** `sha256:<hex>` over the statement's UTF-8 bytes. */
  contentDigest: Sha256Digest;
  /** When the file last changed, as an ISO 8601 timestamp. */
  modifiedAt: string;
  /** The frontmatter `name`, trimmed and clipped. Absent when the file has none. */
  label?: string;
  /** The frontmatter `description`, trimmed and clipped. Absent when the file has none. */
  summary?: string;
  /** The frontmatter `metadata.type` or `type`, lowercased. Absent unless it reads as a type. */
  memoryType?: string;
}

/** Every memory file one complete scan found in one location. */
export interface MemoryScan {
  harness: TachoHarness;
  /** The folder the scan read, ending in the platform's path separator. */
  root: string;
  /** Each memory file the scan found under `root`, sorted. */
  paths: string[];
}

/** Where one harness keeps its memory files. */
export interface HarnessMemoryLocation {
  harness: TachoHarness;
  /** The folder that holds one folder per project, for a home directory. */
  projectsDir: (home: string) => string;
  /** The folder inside each project folder that holds the memory files. */
  memoryDir: string;
  /** The extension every memory file carries. */
  extension: string;
  /** File names in the memory folder that are not memories. */
  skip: readonly string[];
}

export const HARNESS_MEMORY_LOCATIONS: readonly HarnessMemoryLocation[] = [
  // Codex, Cursor, stella, and claude-desktop have no known memory folder.
  {
    harness: "claude-code",
    projectsDir: (home) => join(home, ".claude", "projects"),
    memoryDir: "memory",
    extension: ".md",
    skip: ["MEMORY.md"],
  },
];

/** The file system calls the reader makes. `node:fs/promises` fits it. */
export interface MemoryReaderFs {
  /**
   * The names in a directory. Rejects when it cannot be listed, with the
   * error's `code` set the way `node:fs` sets it (`ENOENT`, `EACCES`, ...).
   */
  readdir: (path: string) => Promise<string[]>;
  /** Whether a path is a file, and when it last changed. */
  stat: (path: string) => Promise<{ isFile: () => boolean; mtimeMs: number }>;
  /** A file's text, read as UTF-8. */
  readFile: (path: string) => Promise<string>;
}

export interface MemoryReaderDeps {
  /** The home directory the harnesses' folders live under. */
  home: string;
  fs: MemoryReaderFs;
  /** Upload one entry. A rejection leaves it unsent for the next scan. */
  send: (entry: LocalMemoryEntry) => Promise<void>;
  /** The locations to read. Defaults to `HARNESS_MEMORY_LOCATIONS`. */
  harnesses?: readonly HarnessMemoryLocation[];
}

/** What one scan did. */
export interface MemoryScanResult {
  /** Entries sent. */
  sent: number;
  /** One list per location, present only when the scan was complete. */
  scans?: MemoryScan[];
}

export interface MemoryReader {
  /** Read every location once and send what is new. */
  scan: () => Promise<MemoryScanResult>;
}

/**
 * YAML frontmatter: a `---` line, any lines, and a closing `---` line, at the
 * very start of the file. Without the closing line nothing is stripped. The
 * group holds the lines between the two rules.
 */
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** One `key: value` frontmatter line, with its indentation. */
const FRONTMATTER_LINE = /^([ \t]*)([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/;

/**
 * Clip to `max` UTF-16 units, which is never more code points than the API
 * counts, without splitting a surrogate pair.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/**
 * A frontmatter value without its quotes. A block scalar (`|` or `>`) reads
 * as no value, because Claude Code writes every field on one line.
 */
function scalar(raw: string): string | undefined {
  const value = raw.trim();
  if (/^[|>][+-]?$/.test(value)) return undefined;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return value.slice(1, -1).replace(/\\"/g, '"');
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

interface Frontmatter {
  name?: string;
  description?: string;
  type?: string;
  metadataType?: string;
}

/**
 * The fields the reader keeps from a frontmatter block. Only top-level
 * `name`, `description`, and `type`, and `type` one level under `metadata:`,
 * are read. Claude Code writes `type` under `metadata` on disk, where its
 * docs show it at the top level, so the reader takes either.
 */
function frontmatterOf(block: string): Frontmatter {
  const fields: Frontmatter = {};
  let inMetadata = false;
  for (const line of block.split(/\r?\n/)) {
    const match = FRONTMATTER_LINE.exec(line);
    if (match === null) continue;
    const [, indent = "", key = "", raw = ""] = match;
    if (indent === "") {
      inMetadata = key === "metadata" && raw.trim() === "";
      if (key === "name" || key === "description" || key === "type") {
        const value = scalar(raw);
        if (value !== undefined) fields[key] = value;
      }
      continue;
    }
    if (inMetadata && key === "type") {
      const value = scalar(raw);
      if (value !== undefined) fields.metadataType = value;
    }
  }
  return fields;
}

/** A frontmatter text field, trimmed and clipped, or undefined when empty. */
function textField(
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const text = clip(value.trim(), max);
  return text.length > 0 ? text : undefined;
}

/** The memory's type, lowercased, or undefined unless it reads as one. */
function typeField(fields: Frontmatter): string | undefined {
  const value = (fields.metadataType ?? fields.type)?.trim().toLowerCase();
  return value !== undefined && MEMORY_TYPE_PATTERN.test(value)
    ? value
    : undefined;
}

/** What a memory file holds: its statement and its frontmatter fields. */
interface MemoryText {
  statement: string;
  label?: string;
  summary?: string;
  memoryType?: string;
}

/** A memory file's body without frontmatter, and its frontmatter fields. */
function memoryTextOf(text: string): MemoryText {
  const unmarked = text.replace(/^\uFEFF/, "");
  const match = FRONTMATTER.exec(unmarked);
  const body = match === null ? unmarked : unmarked.slice(match[0].length);
  const fields = match === null ? {} : frontmatterOf(match[1] ?? "");
  const label = textField(fields.name, MEMORY_LABEL_MAX_CHARS);
  const summary = textField(fields.description, MEMORY_SUMMARY_MAX_CHARS);
  const memoryType = typeField(fields);
  return {
    statement: clip(body.trim(), MEMORY_STATEMENT_MAX_CHARS),
    ...(label !== undefined ? { label } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(memoryType !== undefined ? { memoryType } : {}),
  };
}

/** The digest the reader compares between scans: the statement and the three fields. */
function sentDigest(entry: LocalMemoryEntry): Sha256Digest {
  return digestBytes(
    JSON.stringify([
      entry.statement,
      entry.label ?? null,
      entry.summary ?? null,
      entry.memoryType ?? null,
    ]),
  );
}

/** Whether a file system error says the path is not there. */
function isMissing(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A folder's names, and whether the folder was read or is not there. */
interface Listing {
  names: string[];
  /** False when the folder exists and could not be listed. */
  complete: boolean;
}

/** What the reader found at one listed memory file path. */
type FileRead =
  /** Not a memory file after all: a folder, or a file gone since the listing. */
  | { kind: "absent" }
  /** A file with no body past its frontmatter, which holds no memory. */
  | { kind: "empty" }
  /** A file the reader could not read now. It exists, so a scan counts it. */
  | { kind: "unreadable" }
  | { kind: "entry"; entry: LocalMemoryEntry };

export function createMemoryReader(deps: MemoryReaderDeps): MemoryReader {
  const harnesses = deps.harnesses ?? HARNESS_MEMORY_LOCATIONS;
  /** The digest of what was last sent, by file path. */
  const sent = new Map<string, Sha256Digest>();
  let running: Promise<MemoryScanResult> | undefined;

  /** A directory's names in order. A folder that is not there lists empty. */
  async function list(dir: string): Promise<Listing> {
    try {
      return { names: (await deps.fs.readdir(dir)).sort(), complete: true };
    } catch (error) {
      // Most projects have no memory folder, and a harness that is not
      // installed has no projects folder. Any other failure leaves the
      // folder's files unknown, so the scan is not complete.
      return { names: [], complete: isMissing(error) };
    }
  }

  async function readAt(
    harness: TachoHarness,
    path: string,
  ): Promise<FileRead> {
    let info: Awaited<ReturnType<MemoryReaderFs["stat"]>>;
    try {
      info = await deps.fs.stat(path);
    } catch (error) {
      // A file removed since the listing is gone. Any other failure leaves
      // a file that exists, which is read again at the next scan.
      return isMissing(error) ? { kind: "absent" } : { kind: "unreadable" };
    }
    if (!info.isFile()) return { kind: "absent" };
    let text: string;
    try {
      text = await deps.fs.readFile(path);
    } catch (error) {
      return isMissing(error) ? { kind: "absent" } : { kind: "unreadable" };
    }
    const memory = memoryTextOf(text);
    if (memory.statement.length === 0) return { kind: "empty" };
    return {
      kind: "entry",
      entry: {
        harness,
        path,
        ...memory,
        contentDigest: digestBytes(memory.statement),
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      },
    };
  }

  async function scanOnce(): Promise<MemoryScanResult> {
    let count = 0;
    let complete = true;
    const scans: MemoryScan[] = [];
    const seen = new Set<string>();
    for (const location of harnesses) {
      const root = location.projectsDir(deps.home);
      const paths: string[] = [];
      const projects = await list(root);
      if (!projects.complete) complete = false;
      for (const project of projects.names) {
        const dir = join(root, project, location.memoryDir);
        const files = await list(dir);
        if (!files.complete) complete = false;
        for (const name of files.names) {
          if (!name.endsWith(location.extension)) continue;
          if (location.skip.includes(name)) continue;
          const path = join(dir, name);
          const read = await readAt(location.harness, path);
          if (read.kind === "absent" || read.kind === "empty") continue;
          paths.push(path);
          seen.add(path);
          if (read.kind !== "entry") continue;
          const digest = sentDigest(read.entry);
          if (sent.get(path) === digest) continue;
          try {
            await deps.send(read.entry);
          } catch {
            // A failed send is almost always the API's failure, not the
            // entry's, so the rest of the scan would fail the same way. This
            // entry and every one after it wait for the next scan, and the
            // scan is not complete.
            return { sent: count };
          }
          sent.set(path, digest);
          count += 1;
        }
      }
      scans.push({
        harness: location.harness,
        root: root.endsWith(sep) ? root : `${root}${sep}`,
        paths: paths.sort(),
      });
    }
    if (!complete) return { sent: count };
    for (const path of [...sent.keys()]) if (!seen.has(path)) sent.delete(path);
    return { sent: count, scans };
  }

  return {
    // A scan that overlaps one still running joins it, so no entry is sent
    // twice at once.
    scan: () => {
      running ??= scanOnce().finally(() => {
        running = undefined;
      });
      return running;
    },
  };
}
