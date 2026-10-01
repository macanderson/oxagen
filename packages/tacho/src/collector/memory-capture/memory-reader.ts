/**
 * The memory reader: finds the memories each harness keeps on this machine
 * and hands each new one to `send`, which uploads it to Oxagen as a
 * `local_gateway` memory (memory/v1).
 *
 * Claude Code keeps one memory per file. Its project memories sit in
 * `~/.claude/projects/<project>/memory/`, with `MEMORY.md` as the index. A
 * subagent keeps its own in a folder named for it: under
 * `~/.claude/agent-memory/` for a user subagent, and under
 * `<project>/.claude/agent-memory/` or `<project>/.claude/agent-memory-local/`
 * for a project subagent. The reader reads a subagent's files the way it
 * reads project memory files, and skips the subagent's `MEMORY.md` too.
 * The file's frontmatter `name`, `description`, and `type` (top-level or
 * under `metadata:`) travel with it as the memory's label, summary, and type.
 *
 * Codex keeps its memories in a SQLite store, one row per thread, which the
 * reader reads through a `MemoryStore` (`./codex-store`). A store names each
 * memory by a path under its root, such as `thread/<thread_id>`, and may
 * hold the harness's own count of the memory's uses. The scan hands those
 * counts back for `record_tacho_memory_uses` (`./memory-counts`).
 *
 * The reader keeps, for each memory, a digest of what it last sent: the
 * statement and the three frontmatter fields. A scan sends only the memories
 * that are new or changed, so a frontmatter-only edit is sent too. A file
 * edited back to text it held before is sent again, because the API keeps
 * one waiting memory per file and replaces its text with each new send
 * (ADR-238). Two files with the same text are two sources, and each is sent.
 * A daemon restart sends every memory again, and the API's dedupe key makes
 * the repeat a no-op.
 *
 * A scan also lists every memory it found, one list per location, for
 * `record_tacho_memory_uses`, which retires the memories a scan no longer
 * finds (ADR-245). A location's list comes back only when the scan read all
 * of it: every folder listed, where a missing folder counts as empty, or the
 * whole store read. A partial list would retire memories that still exist.
 * A location whose folder or store is not there sends no list. A harness
 * that is not installed, or a project with no subagent memories, would
 * otherwise cost a list at every scan, and the memories of a folder deleted
 * whole retire as unused instead. A scan whose send failed returns no list.
 * After a location's full read the reader forgets each memory under it that
 * the scan did not find, so a deleted file that comes back unchanged is sent
 * again and its memory returns.
 */
import { isAbsolute, join, sep } from "node:path";
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

/** The most project folders whose subagent memories one scan reads. */
export const MEMORY_PROJECT_DIRS_MAX = 200;

/** One memory, as the reader sends it. */
export interface LocalMemoryEntry {
  harness: TachoHarness;
  /** The memory file's path, or the memory's path in its store. */
  path: string;
  /** The file's body without its frontmatter, trimmed and clipped. */
  statement: string;
  /** `sha256:<hex>` over the statement's UTF-8 bytes. */
  contentDigest: Sha256Digest;
  /** When the memory last changed, as an ISO 8601 timestamp. */
  modifiedAt: string;
  /** The frontmatter `name`, trimmed and clipped. Absent when the file has none. */
  label?: string;
  /** The frontmatter `description`, trimmed and clipped. Absent when the file has none. */
  summary?: string;
  /** The frontmatter `metadata.type` or `type`, lowercased. Absent unless it reads as a type. */
  memoryType?: string;
}

/** Every memory one full read of one location found. */
export interface MemoryScan {
  harness: TachoHarness;
  /**
   * The folder the scan read, ending in the platform's path separator, or a
   * store's root, such as `thread/`.
   */
  root: string;
  /** Each memory the scan found under `root`, sorted. */
  paths: string[];
}

/** Where one harness keeps its memory files. */
export interface HarnessMemoryLocation {
  harness: TachoHarness;
  /**
   * The folder that holds one folder per project or per subagent, for a
   * home directory.
   */
  projectsDir: (home: string) => string;
  /**
   * The folder inside each of those that holds the memory files, or `""`
   * when the files sit in it directly, as a subagent's do.
   */
  memoryDir: string;
  /** The extension every memory file carries. */
  extension: string;
  /** File names in the memory folder that are not memories. */
  skip: readonly string[];
}

/** A Claude Code location: Markdown files, with `MEMORY.md` skipped as the index. */
function claudeCodeLocation(
  projectsDir: (home: string) => string,
  memoryDir: string,
): HarnessMemoryLocation {
  return {
    harness: "claude-code",
    projectsDir,
    memoryDir,
    extension: ".md",
    skip: ["MEMORY.md"],
  };
}

/**
 * The default locations under a home directory: Claude Code's project
 * memories and its user subagents' memories. Codex keeps its memories in a
 * store (`./codex-store`). Cursor, Stella, and Claude Desktop have no memory
 * folder the reader reads.
 */
export const HARNESS_MEMORY_LOCATIONS: readonly HarnessMemoryLocation[] = [
  claudeCodeLocation((home) => join(home, ".claude", "projects"), "memory"),
  claudeCodeLocation((home) => join(home, ".claude", "agent-memory"), ""),
];

/**
 * Claude Code's locations for the config directory `configDir`
 * (`$CLAUDE_CONFIG_DIR`, else `~/.claude`): its project memories, its user
 * subagents' memories, and the project subagents' memories of each folder in
 * `projectDirs`.
 */
export function claudeCodeMemoryLocations(
  configDir: string,
  projectDirs: readonly string[] = [],
): HarnessMemoryLocation[] {
  const locations = [
    claudeCodeLocation(() => join(configDir, "projects"), "memory"),
    claudeCodeLocation(() => join(configDir, "agent-memory"), ""),
  ];
  for (const dir of projectDirs.slice(0, MEMORY_PROJECT_DIRS_MAX))
    locations.push(
      claudeCodeLocation(() => join(dir, ".claude", "agent-memory"), ""),
      claudeCodeLocation(() => join(dir, ".claude", "agent-memory-local"), ""),
    );
  return locations;
}

/** What the reader needs to know of one Claude Code session. */
export interface ProjectSession {
  /** The harness that runs the session. Absent means Claude Code. */
  harness?: string;
  /** Where the session started. */
  cwd?: string;
  /** Each repository root the session worked in, as git read it. */
  baselines?: Record<string, string>;
}

/**
 * The folders whose project subagent memories a scan reads: where each
 * Claude Code session started, and each repository root it worked in,
 * newest session first, each once, at most `MEMORY_PROJECT_DIRS_MAX`.
 * `sessions` runs oldest first, as the session registry lists them.
 */
export function projectDirsOf(sessions: readonly ProjectSession[]): string[] {
  const dirs = new Set<string>();
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const session = sessions[i];
    if (session === undefined) continue;
    if (session.harness !== undefined && session.harness !== "claude-code")
      continue;
    for (const dir of [session.cwd, ...Object.keys(session.baselines ?? {})])
      if (dir !== undefined && isAbsolute(dir)) dirs.add(dir);
    if (dirs.size >= MEMORY_PROJECT_DIRS_MAX) break;
  }
  return [...dirs].slice(0, MEMORY_PROJECT_DIRS_MAX);
}

/** One memory a harness keeps in a store rather than in a file. */
export interface StoredMemory {
  /** The memory's path in the store, under the store's root. */
  path: string;
  /** The memory's statement. The reader trims and clips it. */
  statement: string;
  label?: string;
  summary?: string;
  memoryType?: string;
  /** When the memory last changed, as an ISO 8601 timestamp. */
  modifiedAt: string;
  /** How many times the harness counted a use of the memory, when it counts. */
  useCount?: number;
  /** When the harness last used the memory, as an ISO 8601 timestamp. */
  lastUsedAt?: string;
}

/** What one read of a store found. */
export type MemoryStoreRead =
  /** No store is there: the harness is not installed or keeps no memories. */
  | { kind: "missing" }
  /** A store is there and could not be read now. */
  | { kind: "unavailable" }
  | { kind: "read"; memories: StoredMemory[] };

/** Where one harness keeps its memories in a store, such as Codex's SQLite file. */
export interface MemoryStore {
  harness: TachoHarness;
  /** The prefix every memory path in the store starts with, ending in `/`. */
  root: string;
  read: () => Promise<MemoryStoreRead>;
}

/** The uses a harness counted itself, as one full read of its store found them. */
export interface HarnessUseCounts {
  harness: TachoHarness;
  /** The store's root. Every path in `counts` starts with it. */
  root: string;
  /** Each memory the scan sent or found unchanged, with the count the store holds now. */
  counts: Array<{ path: string; count: number; lastUsedAt?: string }>;
}

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
  /**
   * The locations to read, or a function the scan calls for them each time.
   * Defaults to `HARNESS_MEMORY_LOCATIONS`.
   */
  harnesses?:
    | readonly HarnessMemoryLocation[]
    | (() => readonly HarnessMemoryLocation[]);
  /** The stores to read after the locations, or a function that names them. None by default. */
  stores?: readonly MemoryStore[] | (() => readonly MemoryStore[]);
}

/** What one scan did. */
export interface MemoryScanResult {
  /** Entries sent. */
  sent: number;
  /**
   * One list per location the scan read in full whose folder or store is
   * there. Absent when a send failed and stopped the scan.
   */
  scans?: MemoryScan[];
  /**
   * The harness's own use counts from each store the scan read in full.
   * Absent when a send failed and stopped the scan.
   */
  counts?: HarnessUseCounts[];
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
export function frontmatterScalar(raw: string): string | undefined {
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
        const value = frontmatterScalar(raw);
        if (value !== undefined) fields[key] = value;
      }
      continue;
    }
    if (inMetadata && key === "type") {
      const value = frontmatterScalar(raw);
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
export function isMissing(error: unknown): boolean {
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
  /** True when the folder is there and was listed. */
  found: boolean;
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

/** The key the reader keeps a memory under: its harness and its path. */
const keyOf = (harness: TachoHarness, path: string) => `${harness}\n${path}`;

/** A folder with the platform's path separator on its end. */
const withSep = (dir: string) => (dir.endsWith(sep) ? dir : `${dir}${sep}`);

/** A stored memory's statement and fields, trimmed and clipped like a file's. */
function storedTextOf(memory: StoredMemory): MemoryText {
  const label = textField(memory.label, MEMORY_LABEL_MAX_CHARS);
  const summary = textField(memory.summary, MEMORY_SUMMARY_MAX_CHARS);
  const type = memory.memoryType?.trim().toLowerCase();
  const memoryType =
    type !== undefined && MEMORY_TYPE_PATTERN.test(type) ? type : undefined;
  return {
    statement: clip(memory.statement.trim(), MEMORY_STATEMENT_MAX_CHARS),
    ...(label !== undefined ? { label } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(memoryType !== undefined ? { memoryType } : {}),
  };
}

export function createMemoryReader(deps: MemoryReaderDeps): MemoryReader {
  const harnesses = deps.harnesses ?? HARNESS_MEMORY_LOCATIONS;
  const stores = deps.stores ?? [];
  /** The digest of what was last sent, by harness and path (`keyOf`). */
  const sent = new Map<string, Sha256Digest>();
  let running: Promise<MemoryScanResult> | undefined;

  /** A directory's names in order. A folder that is not there lists empty. */
  async function list(dir: string): Promise<Listing> {
    try {
      return {
        names: (await deps.fs.readdir(dir)).sort(),
        complete: true,
        found: true,
      };
    } catch (error) {
      // Most projects have no memory folder, and a harness that is not
      // installed has no projects folder. Any other failure leaves the
      // folder's files unknown, so the scan is not complete.
      return { names: [], complete: isMissing(error), found: false };
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
    const scans: MemoryScan[] = [];
    const counts: HarnessUseCounts[] = [];
    /** The key prefix of each location the scan read in full. */
    const whole: string[] = [];
    /** The key prefix of each location the scan read, so a repeat is read once. */
    const read = new Set<string>();
    const seen = new Set<string>();

    /**
     * Send an entry unless the reader sent the same digest last. False when
     * the send failed: the API's failure, almost always, so the rest of the
     * scan would fail the same way. The entry and every one after it wait
     * for the next scan.
     */
    async function offer(entry: LocalMemoryEntry): Promise<boolean> {
      const key = keyOf(entry.harness, entry.path);
      const digest = sentDigest(entry);
      if (sent.get(key) === digest) return true;
      try {
        await deps.send(entry);
      } catch {
        return false;
      }
      sent.set(key, digest);
      count += 1;
      return true;
    }

    const locations =
      typeof harnesses === "function" ? harnesses() : harnesses;
    for (const location of locations) {
      const top = location.projectsDir(deps.home);
      const root = withSep(top);
      const prefix = keyOf(location.harness, root);
      if (read.has(prefix)) continue;
      read.add(prefix);
      const paths: string[] = [];
      const projects = await list(top);
      let complete = projects.complete;
      for (const project of projects.names) {
        const dir =
          location.memoryDir === ""
            ? join(top, project)
            : join(top, project, location.memoryDir);
        const files = await list(dir);
        if (!files.complete) complete = false;
        for (const name of files.names) {
          if (!name.endsWith(location.extension)) continue;
          if (location.skip.includes(name)) continue;
          const path = join(dir, name);
          const file = await readAt(location.harness, path);
          if (file.kind === "absent" || file.kind === "empty") continue;
          paths.push(path);
          seen.add(keyOf(location.harness, path));
          if (file.kind !== "entry") continue;
          if (!(await offer(file.entry))) return { sent: count };
        }
      }
      if (!complete) continue;
      whole.push(prefix);
      if (projects.found)
        scans.push({ harness: location.harness, root, paths: paths.sort() });
    }

    for (const store of typeof stores === "function" ? stores() : stores) {
      const prefix = keyOf(store.harness, store.root);
      if (read.has(prefix)) continue;
      read.add(prefix);
      const found = await store.read();
      if (found.kind === "unavailable") continue;
      whole.push(prefix);
      if (found.kind === "missing") continue;
      const paths: string[] = [];
      const useCounts: HarnessUseCounts["counts"] = [];
      for (const memory of found.memories) {
        if (
          !memory.path.startsWith(store.root) ||
          memory.path.length === store.root.length
        )
          continue;
        const key = keyOf(store.harness, memory.path);
        if (seen.has(key)) continue;
        const text = storedTextOf(memory);
        if (text.statement.length === 0) continue;
        paths.push(memory.path);
        seen.add(key);
        const sentNow = await offer({
          harness: store.harness,
          path: memory.path,
          ...text,
          contentDigest: digestBytes(text.statement),
          modifiedAt: memory.modifiedAt,
        });
        if (!sentNow) return { sent: count };
        if (memory.useCount !== undefined)
          useCounts.push({
            path: memory.path,
            count: memory.useCount,
            ...(memory.lastUsedAt !== undefined
              ? { lastUsedAt: memory.lastUsedAt }
              : {}),
          });
      }
      scans.push({
        harness: store.harness,
        root: store.root,
        paths: paths.sort(),
      });
      counts.push({
        harness: store.harness,
        root: store.root,
        counts: useCounts,
      });
    }

    // Forget what a full read no longer found, so it is sent again if it
    // comes back. What a partial read missed may still be there, so the
    // reader keeps it.
    for (const key of [...sent.keys()])
      if (!seen.has(key) && whole.some((prefix) => key.startsWith(prefix)))
        sent.delete(key);
    return { sent: count, scans, counts };
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
