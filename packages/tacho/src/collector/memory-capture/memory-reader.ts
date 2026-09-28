/**
 * The memory reader: finds the memory files a harness keeps on this machine
 * and hands each new one to `send`, which uploads it to Oxagen as a
 * `local_gateway` memory (memory/v1). Claude Code keeps one memory per file
 * in `~/.claude/projects/<project>/memory/`, with `MEMORY.md` as the index.
 *
 * The reader keeps the digest of every statement it sent in memory, so a
 * scan sends only what is new or changed. A daemon restart sends every
 * memory again, and the API's dedupe key makes the repeat a no-op.
 */
import { join } from "node:path";
import { digestBytes, type Sha256Digest } from "../../digest";
import type { TachoHarness } from "../../wire";

/** The longest statement memory/v1 accepts. */
export const MEMORY_STATEMENT_MAX_CHARS = 2_000;

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
  /** The names in a directory. Rejects when it cannot be listed. */
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

export interface MemoryReader {
  /** Read every location once and send what is new. */
  scan: () => Promise<{ sent: number }>;
}

/**
 * YAML frontmatter: a `---` line, any lines, and a closing `---` line, at the
 * very start of the file. Without the closing line nothing is stripped.
 */
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Clip to `MEMORY_STATEMENT_MAX_CHARS` UTF-16 units, which is never more
 * code points than the API counts, without splitting a surrogate pair.
 */
function clip(text: string): string {
  if (text.length <= MEMORY_STATEMENT_MAX_CHARS) return text;
  let end = MEMORY_STATEMENT_MAX_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/** A memory file's statement: its body without frontmatter, trimmed and clipped. */
function statementOf(text: string): string {
  const body = text.replace(/^\uFEFF/, "").replace(FRONTMATTER, "");
  return clip(body.trim());
}

export function createMemoryReader(deps: MemoryReaderDeps): MemoryReader {
  const harnesses = deps.harnesses ?? HARNESS_MEMORY_LOCATIONS;
  const sent = new Set<Sha256Digest>();
  let running: Promise<{ sent: number }> | undefined;

  /** A directory's names in order, or none when it cannot be listed. */
  async function names(dir: string): Promise<string[]> {
    try {
      return (await deps.fs.readdir(dir)).sort();
    } catch {
      // Most projects have no memory folder, and a harness that is not
      // installed has no projects folder.
      return [];
    }
  }

  async function entryAt(
    harness: TachoHarness,
    path: string,
  ): Promise<LocalMemoryEntry | undefined> {
    try {
      const info = await deps.fs.stat(path);
      if (!info.isFile()) return undefined;
      const statement = statementOf(await deps.fs.readFile(path));
      if (statement.length === 0) return undefined;
      return {
        harness,
        path,
        statement,
        contentDigest: digestBytes(statement),
        modifiedAt: new Date(info.mtimeMs).toISOString(),
      };
    } catch {
      // One file that cannot be read now does not stop the scan. It is read
      // again at the next one.
      return undefined;
    }
  }

  async function scanOnce(): Promise<{ sent: number }> {
    let count = 0;
    for (const location of harnesses) {
      const root = location.projectsDir(deps.home);
      for (const project of await names(root)) {
        const dir = join(root, project, location.memoryDir);
        for (const name of await names(dir)) {
          if (!name.endsWith(location.extension)) continue;
          if (location.skip.includes(name)) continue;
          const entry = await entryAt(location.harness, join(dir, name));
          if (entry === undefined || sent.has(entry.contentDigest)) continue;
          try {
            await deps.send(entry);
          } catch {
            // A failed send is almost always the API's failure, not the
            // entry's, so the rest of the scan would fail the same way. This
            // entry and every one after it wait for the next scan.
            return { sent: count };
          }
          sent.add(entry.contentDigest);
          count += 1;
        }
      }
    }
    return { sent: count };
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
