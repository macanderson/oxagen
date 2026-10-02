/**
 * The memory reader (`memory-reader.ts`) over an in-memory file system: what
 * it sends, what it skips, when it sends a memory again, and which scans
 * list the files they found.
 */
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes } from "../../digest";
import {
  createMemoryReader,
  type HarnessMemoryLocation,
  type LocalMemoryEntry,
  MEMORY_LABEL_MAX_CHARS,
  MEMORY_STATEMENT_MAX_CHARS,
  type MemoryReaderFs,
} from "./memory-reader";

const HOME = "/home/dev";
const PROJECTS = join(HOME, ".claude", "projects");
const MTIME = Date.parse("2026-09-20T12:00:00.000Z");

function memoryPath(project: string, name: string): string {
  return join(PROJECTS, project, "memory", name);
}

/** An error the way `node:fs` raises one, with its `code`. */
function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

/** A file system that holds files by path. Directories are implied. */
class FakeFs implements MemoryReaderFs {
  readonly files = new Map<string, { text: string; mtimeMs: number }>();
  /** Paths whose read rejects, as a file without read permission would. */
  readonly unreadable = new Set<string>();
  /** Folders whose listing rejects with EACCES. */
  readonly unlistable = new Set<string>();

  write(path: string, text: string, mtimeMs = MTIME): void {
    this.files.set(path, { text, mtimeMs });
  }

  private isDir(path: string): boolean {
    for (const file of this.files.keys())
      if (file.startsWith(`${path}/`)) return true;
    return false;
  }

  readdir = async (path: string): Promise<string[]> => {
    if (this.unlistable.has(path)) throw fsError("EACCES", path);
    if (this.files.has(path)) throw fsError("ENOTDIR", path);
    if (!this.isDir(path)) throw fsError("ENOENT", path);
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(`${path}/`)) continue;
      const rest = file.slice(path.length + 1);
      const name = rest.split("/")[0];
      if (name !== undefined) names.add(name);
    }
    // Unsorted on purpose: the reader sorts.
    return [...names].reverse();
  };

  stat = async (
    path: string,
  ): Promise<{ isFile: () => boolean; mtimeMs: number }> => {
    const file = this.files.get(path);
    if (file !== undefined)
      return { isFile: () => true, mtimeMs: file.mtimeMs };
    if (this.isDir(path)) return { isFile: () => false, mtimeMs: MTIME };
    throw fsError("ENOENT", path);
  };

  readFile = async (path: string): Promise<string> => {
    if (this.unreadable.has(path)) throw fsError("EACCES", path);
    const file = this.files.get(path);
    if (file === undefined) throw fsError("ENOENT", path);
    return file.text;
  };
}

function reader(
  fs: FakeFs,
  send: (entry: LocalMemoryEntry) => Promise<void> = async () => {},
  harnesses?: readonly HarnessMemoryLocation[],
) {
  const sent: LocalMemoryEntry[] = [];
  const memoryReader = createMemoryReader({
    home: HOME,
    fs,
    send: async (entry) => {
      await send(entry);
      sent.push(entry);
    },
    ...(harnesses !== undefined ? { harnesses } : {}),
  });
  return { memoryReader, sent };
}

describe("a scan", () => {
  it("sends every memory file once, in path order, with its facts", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj-b", "rule.md"), "Use pnpm.\n");
    fs.write(
      memoryPath("-proj-a", "style.md"),
      "Headings are plain nouns.",
      Date.parse("2026-09-21T08:30:00.000Z"),
    );
    fs.write(memoryPath("-proj-a", "deploy.md"), "Only the tip deploys.");
    const { memoryReader, sent } = reader(fs);

    expect((await memoryReader.scan()).sent).toBe(3);
    expect(sent).toEqual([
      {
        harness: "claude-code",
        path: memoryPath("-proj-a", "deploy.md"),
        statement: "Only the tip deploys.",
        contentDigest: digestBytes("Only the tip deploys."),
        modifiedAt: "2026-09-20T12:00:00.000Z",
      },
      {
        harness: "claude-code",
        path: memoryPath("-proj-a", "style.md"),
        statement: "Headings are plain nouns.",
        contentDigest: digestBytes("Headings are plain nouns."),
        modifiedAt: "2026-09-21T08:30:00.000Z",
      },
      {
        harness: "claude-code",
        path: memoryPath("-proj-b", "rule.md"),
        statement: "Use pnpm.",
        contentDigest: digestBytes("Use pnpm."),
        modifiedAt: "2026-09-20T12:00:00.000Z",
      },
    ]);
  });

  it("skips MEMORY.md, other extensions, folders, and files outside a memory folder", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "MEMORY.md"), "- [Rule](rule.md) — index");
    fs.write(memoryPath("-proj", "notes.txt"), "Not a memory.");
    fs.write(memoryPath("-proj", "folder.md/inner.md"), "Nested.");
    fs.write(join(PROJECTS, "-proj", "session.jsonl"), "{}");
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs);

    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.path)).toEqual([
      memoryPath("-proj", "rule.md"),
    ]);
  });

  it("sends nothing when the projects folder is missing, and lists no file", async () => {
    const { memoryReader, sent } = reader(new FakeFs());
    expect(await memoryReader.scan()).toEqual({
      sent: 0,
      scans: [{ harness: "claude-code", root: `${PROJECTS}${sep}`, paths: [] }],
    });
    expect(sent).toEqual([]);
  });

  it("reads the locations it is given", async () => {
    const fs = new FakeFs();
    fs.write("/config/claude/projects/-proj/memory/rule.md", "Use pnpm.");
    const { memoryReader, sent } = reader(fs, undefined, [
      {
        harness: "claude-code",
        projectsDir: () => "/config/claude/projects",
        memoryDir: "memory",
        extension: ".md",
        skip: [],
      },
    ]);
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent[0]?.path).toBe("/config/claude/projects/-proj/memory/rule.md");
  });
});

describe("a statement", () => {
  async function statementOf(text: string): Promise<string | undefined> {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "m.md"), text);
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    return sent[0]?.statement;
  }

  it("leaves out the frontmatter", async () => {
    expect(
      await statementOf(
        "---\nname: Deploys\ndescription: tip only\ntype: project\n---\n\nOnly the tip deploys.\n",
      ),
    ).toBe("Only the tip deploys.");
  });

  it("leaves out frontmatter written with CRLF after a byte-order mark", async () => {
    expect(
      await statementOf("﻿---\r\nname: x\r\n---\r\nBody.\r\n"),
    ).toBe("Body.");
  });

  it("leaves out empty frontmatter", async () => {
    expect(await statementOf("---\n---\nBody.")).toBe("Body.");
  });

  it("keeps the text when the frontmatter never closes", async () => {
    expect(await statementOf("---\nname: x\nBody.")).toBe(
      "---\nname: x\nBody.",
    );
  });

  it("keeps a rule line that is not at the start", async () => {
    expect(await statementOf("Intro.\n---\nMore.")).toBe(
      "Intro.\n---\nMore.",
    );
  });

  it("skips a file with nothing past its frontmatter", async () => {
    expect(await statementOf("---\nname: x\n---\n  \n")).toBeUndefined();
    expect(await statementOf("")).toBeUndefined();
  });

  it("clips a long body to the limit memory/v1 accepts", async () => {
    const statement = await statementOf("m".repeat(2_500));
    expect(statement).toBe("m".repeat(MEMORY_STATEMENT_MAX_CHARS));
  });

  it("does not split a surrogate pair at the limit", async () => {
    const statement = await statementOf(
      `${"m".repeat(MEMORY_STATEMENT_MAX_CHARS - 1)}\u{1F600}${"m".repeat(10)}`,
    );
    expect(statement).toBe("m".repeat(MEMORY_STATEMENT_MAX_CHARS - 1));
  });
});

describe("a later scan", () => {
  it("does not send an unchanged file again", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    // A new modification time with the same text is the same memory.
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.", MTIME + 60_000);
    expect((await memoryReader.scan()).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("sends a changed file again", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    fs.write(
      memoryPath("-proj", "rule.md"),
      "Use pnpm, never npm.",
      MTIME + 60_000,
    );
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.statement)).toEqual([
      "Use pnpm.",
      "Use pnpm, never npm.",
    ]);
    expect(sent[1]?.modifiedAt).toBe(new Date(MTIME + 60_000).toISOString());
  });

  it("sends a file again when it changes back to text it held before", async () => {
    // The API keeps one waiting memory per file and replaces its text at
    // each send, so a file edited back must be sent, or the waiting memory
    // keeps the text in between.
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    fs.write(memoryPath("-proj", "rule.md"), "Use npm.", MTIME + 60_000);
    await memoryReader.scan();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.", MTIME + 120_000);
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.statement)).toEqual([
      "Use pnpm.",
      "Use npm.",
      "Use pnpm.",
    ]);
  });

  it("sends two files with the same text once each", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj-a", "rule.md"), "Use pnpm.");
    fs.write(memoryPath("-proj-b", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs);
    expect((await memoryReader.scan()).sent).toBe(2);
    expect(sent.map((entry) => entry.path)).toEqual([
      memoryPath("-proj-a", "rule.md"),
      memoryPath("-proj-b", "rule.md"),
    ]);
    expect((await memoryReader.scan()).sent).toBe(0);
  });

  it("sends again what a failed send left, and stops the scan at the failure", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "a.md"), "First.");
    fs.write(memoryPath("-proj", "b.md"), "Second.");
    fs.write(memoryPath("-proj", "c.md"), "Third.");
    let down = true;
    const attempts: string[] = [];
    const { memoryReader, sent } = reader(fs, async (entry) => {
      attempts.push(entry.statement);
      if (down && entry.statement === "Second.")
        throw new Error("the control plane answered 503");
    });

    // A scan a failed send ended lists no files, so nothing retires.
    expect(await memoryReader.scan()).toEqual({ sent: 1 });
    expect(attempts).toEqual(["First.", "Second."]);
    down = false;
    expect((await memoryReader.scan()).sent).toBe(2);
    expect(sent.map((entry) => entry.statement)).toEqual([
      "First.",
      "Second.",
      "Third.",
    ]);
  });

  it("goes on past a file it cannot read, and sends it once it can", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "a.md"), "Locked.");
    fs.write(memoryPath("-proj", "b.md"), "Open.");
    fs.unreadable.add(memoryPath("-proj", "a.md"));
    const { memoryReader, sent } = reader(fs);

    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.statement)).toEqual(["Open."]);
    fs.unreadable.clear();
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.statement)).toEqual(["Open.", "Locked."]);
  });

  it("goes on past a file that disappears between the listing and the read", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "a.md"), "Gone.");
    fs.write(memoryPath("-proj", "b.md"), "Here.");
    const stat = fs.stat;
    fs.stat = async (path) => {
      if (path === memoryPath("-proj", "a.md")) {
        fs.files.delete(path);
        throw fsError("ENOENT", path);
      }
      return stat(path);
    };
    const { memoryReader, sent } = reader(fs);
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.statement)).toEqual(["Here."]);
  });

  it("joins a scan still running rather than send twice", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { memoryReader, sent } = reader(fs, () => gate);

    const first = memoryReader.scan();
    const second = memoryReader.scan();
    expect(second).toBe(first);
    release();
    expect((await first).sent).toBe(1);
    expect((await second).sent).toBe(1);
    expect(sent).toHaveLength(1);
    // Once it ends, the next scan is a new one, with nothing left to send.
    const third = memoryReader.scan();
    expect(third).not.toBe(first);
    expect((await third).sent).toBe(0);
  });
});

describe("the frontmatter fields", () => {
  async function entryOf(text: string): Promise<LocalMemoryEntry | undefined> {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "m.md"), text);
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    return sent[0];
  }

  it("sends name, description, and a nested type as label, summary, and type", async () => {
    const entry = await entryOf(
      "---\nname: Deploys\ndescription: 'Only the tip deploys, never a branch'\nmetadata:\n  type: Feedback\n---\nOnly the tip deploys.\n",
    );
    expect(entry).toMatchObject({
      statement: "Only the tip deploys.",
      label: "Deploys",
      summary: "Only the tip deploys, never a branch",
      memoryType: "feedback",
    });
  });

  it("takes a top-level type and double quotes", async () => {
    const entry = await entryOf(
      '---\nname: "Use \\"pnpm\\""\ntype: project\n---\nUse pnpm.',
    );
    expect(entry).toMatchObject({ label: 'Use "pnpm"', memoryType: "project" });
    expect(entry?.summary).toBeUndefined();
  });

  it("prefers the type under metadata to a top-level one", async () => {
    const entry = await entryOf(
      "---\ntype: project\nmetadata:\n  type: user\n---\nBody.",
    );
    expect(entry?.memoryType).toBe("user");
  });

  it("leaves out a type that does not read as one, empty fields, and block scalars", async () => {
    const entry = await entryOf(
      "---\nname:   \ndescription: |\n  long text\ntype: Not A Type\n---\nBody.",
    );
    expect(entry).toBeDefined();
    expect(entry && "label" in entry).toBe(false);
    expect(entry && "summary" in entry).toBe(false);
    expect(entry && "memoryType" in entry).toBe(false);
  });

  it("does not read a key indented under another key as a top-level field", async () => {
    const entry = await entryOf(
      "---\nother:\n  name: nested\n  type: nested\n---\nBody.",
    );
    expect(entry && "label" in entry).toBe(false);
    expect(entry && "memoryType" in entry).toBe(false);
  });

  it("clips a long name to the label limit", async () => {
    const entry = await entryOf(`---\nname: ${"n".repeat(300)}\n---\nBody.`);
    expect(entry?.label).toBe("n".repeat(MEMORY_LABEL_MAX_CHARS));
  });

  it("sends a file again when only its frontmatter changes", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "m.md"), "---\nname: Old\n---\nBody.");
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    fs.write(memoryPath("-proj", "m.md"), "---\nname: New\n---\nBody.");
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.label)).toEqual(["Old", "New"]);
    // The digest the API compares is the statement's, which did not change.
    expect(sent[0]?.contentDigest).toBe(sent[1]?.contentDigest);
  });
});

describe("the files a scan found", () => {
  it("lists every memory file a complete scan found, under a root that ends in a separator", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj-b", "rule.md"), "Use pnpm.");
    fs.write(memoryPath("-proj-a", "style.md"), "Plain nouns.");
    fs.write(memoryPath("-proj-a", "MEMORY.md"), "- index");
    fs.write(memoryPath("-proj-a", "notes.txt"), "Not a memory.");
    fs.write(memoryPath("-proj-a", "empty.md"), "---\nname: x\n---\n");
    fs.write(memoryPath("-proj-a", "locked.md"), "Locked.");
    fs.write(join(PROJECTS, "-proj-c", "session.jsonl"), "{}");
    fs.unreadable.add(memoryPath("-proj-a", "locked.md"));
    const { memoryReader } = reader(fs);

    const result = await memoryReader.scan();
    expect(result.sent).toBe(2);
    // A file that holds no memory is not listed. One that cannot be read
    // now still exists, so it is.
    expect(result.scans).toEqual([
      {
        harness: "claude-code",
        root: `${PROJECTS}${sep}`,
        paths: [
          memoryPath("-proj-a", "locked.md"),
          memoryPath("-proj-a", "style.md"),
          memoryPath("-proj-b", "rule.md"),
        ],
      },
    ]);
    // Every path starts with the root, as record_tacho_memory_uses requires.
    for (const path of result.scans?.[0]?.paths ?? [])
      expect(path.startsWith(result.scans?.[0]?.root ?? "?")).toBe(true);
  });

  it("lists unchanged files too, on every scan", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader } = reader(fs);
    await memoryReader.scan();
    expect(await memoryReader.scan()).toEqual({
      sent: 0,
      scans: [
        {
          harness: "claude-code",
          root: `${PROJECTS}${sep}`,
          paths: [memoryPath("-proj", "rule.md")],
        },
      ],
    });
  });

  it("lists nothing when a memory folder cannot be listed", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj-a", "a.md"), "First.");
    fs.write(memoryPath("-proj-b", "b.md"), "Second.");
    fs.unlistable.add(join(PROJECTS, "-proj-a", "memory"));
    const { memoryReader, sent } = reader(fs);
    // The folder's files are unknown, so a list would retire their memories.
    expect(await memoryReader.scan()).toEqual({ sent: 1 });
    expect(sent.map((entry) => entry.statement)).toEqual(["Second."]);
  });

  it("lists nothing when the projects folder cannot be listed", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "a.md"), "First.");
    fs.unlistable.add(PROJECTS);
    const { memoryReader } = reader(fs);
    expect(await memoryReader.scan()).toEqual({ sent: 0 });
  });

  it("sends a deleted file again when it comes back unchanged", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    fs.files.delete(memoryPath("-proj", "rule.md"));
    const gone = await memoryReader.scan();
    expect(gone.scans?.[0]?.paths).toEqual([]);
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent.map((entry) => entry.statement)).toEqual([
      "Use pnpm.",
      "Use pnpm.",
    ]);
  });

  it("remembers a file an incomplete scan could not see", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs);
    await memoryReader.scan();
    fs.unlistable.add(join(PROJECTS, "-proj", "memory"));
    expect(await memoryReader.scan()).toEqual({ sent: 0 });
    fs.unlistable.clear();
    // The file never left, so it is not sent again.
    expect((await memoryReader.scan()).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });
});
