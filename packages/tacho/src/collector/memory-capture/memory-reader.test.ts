/**
 * The memory reader (`memory-reader.ts`) over an in-memory file system: what
 * it sends, what it skips, when it sends a memory again, and which scans
 * list the files they found.
 */
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes } from "../../digest";
import {
  claudeCodeMemoryLocations,
  createMemoryReader,
  type HarnessMemoryLocation,
  type LocalMemoryEntry,
  MEMORY_LABEL_MAX_CHARS,
  MEMORY_PROJECT_DIRS_MAX,
  MEMORY_STATEMENT_MAX_CHARS,
  type MemoryReaderFs,
  type MemoryStore,
  type MemoryStoreRead,
  projectDirsOf,
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
  harnesses?:
    | readonly HarnessMemoryLocation[]
    | (() => readonly HarnessMemoryLocation[]),
  stores?: readonly MemoryStore[],
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
    ...(stores !== undefined ? { stores } : {}),
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

  it("sends nothing and lists nothing when the projects folder is missing", async () => {
    // No folder means no harness to retire memories for, and a list for
    // every missing folder would cost a call at every scan.
    const { memoryReader, sent } = reader(new FakeFs());
    expect(await memoryReader.scan()).toEqual({
      sent: 0,
      scans: [],
      counts: [],
    });
    expect(sent).toEqual([]);
  });

  it("lists a projects folder that is there and holds no memory", async () => {
    const fs = new FakeFs();
    fs.write(join(PROJECTS, "-proj", "session.jsonl"), "{}");
    const { memoryReader } = reader(fs);
    expect((await memoryReader.scan()).scans).toEqual([
      { harness: "claude-code", root: `${PROJECTS}${sep}`, paths: [] },
    ]);
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
      counts: [],
    });
  });

  it("lists nothing when a memory folder cannot be listed", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj-a", "a.md"), "First.");
    fs.write(memoryPath("-proj-b", "b.md"), "Second.");
    fs.unlistable.add(join(PROJECTS, "-proj-a", "memory"));
    const { memoryReader, sent } = reader(fs);
    // The folder's files are unknown, so a list would retire their memories.
    expect(await memoryReader.scan()).toEqual({
      sent: 1,
      scans: [],
      counts: [],
    });
    expect(sent.map((entry) => entry.statement)).toEqual(["Second."]);
  });

  it("lists nothing when the projects folder cannot be listed", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "a.md"), "First.");
    fs.unlistable.add(PROJECTS);
    const { memoryReader } = reader(fs);
    expect(await memoryReader.scan()).toEqual({
      sent: 0,
      scans: [],
      counts: [],
    });
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
    expect(await memoryReader.scan()).toEqual({
      sent: 0,
      scans: [],
      counts: [],
    });
    fs.unlistable.clear();
    // The file never left, so it is not sent again.
    expect((await memoryReader.scan()).sent).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

const AGENT_MEMORY = join(HOME, ".claude", "agent-memory");
const REPO = "/home/dev/work/app";

describe("subagent memories", () => {
  it("reads a user subagent's files like project memory files, and skips its MEMORY.md", async () => {
    const fs = new FakeFs();
    fs.write(join(AGENT_MEMORY, "reviewer", "MEMORY.md"), "- [a](a.md)");
    fs.write(join(AGENT_MEMORY, "reviewer", "a.md"), "---\nname: a\n---\nCheck the tests.");
    fs.write(join(AGENT_MEMORY, "reviewer", "notes.txt"), "Not a memory.");
    fs.write(join(AGENT_MEMORY, "reviewer", "deep", "b.md"), "Nested.");
    fs.write(join(AGENT_MEMORY, "loose.md"), "Not in a subagent's folder.");
    const { memoryReader, sent } = reader(fs);

    const result = await memoryReader.scan();
    expect(sent).toEqual([
      {
        harness: "claude-code",
        path: join(AGENT_MEMORY, "reviewer", "a.md"),
        statement: "Check the tests.",
        contentDigest: digestBytes("Check the tests."),
        modifiedAt: "2026-09-20T12:00:00.000Z",
        label: "a",
      },
    ]);
    expect(result.scans).toEqual([
      {
        harness: "claude-code",
        root: `${AGENT_MEMORY}${sep}`,
        paths: [join(AGENT_MEMORY, "reviewer", "a.md")],
      },
    ]);
  });

  it("reads each project folder's agent-memory and agent-memory-local folders", async () => {
    const fs = new FakeFs();
    const config = "/cfg/claude";
    const shared = join(REPO, ".claude", "agent-memory", "planner", "p.md");
    const local = join(REPO, ".claude", "agent-memory-local", "planner", "l.md");
    fs.write(shared, "Plan in small steps.");
    fs.write(local, "Use the staging key.");
    const { memoryReader, sent } = reader(
      fs,
      undefined,
      claudeCodeMemoryLocations(config, [REPO, "/home/dev/empty"]),
    );

    const result = await memoryReader.scan();
    expect(sent.map((entry) => entry.path)).toEqual([shared, local]);
    // A project with no subagent memories sends no list.
    expect(result.scans).toEqual([
      {
        harness: "claude-code",
        root: `${join(REPO, ".claude", "agent-memory")}${sep}`,
        paths: [shared],
      },
      {
        harness: "claude-code",
        root: `${join(REPO, ".claude", "agent-memory-local")}${sep}`,
        paths: [local],
      },
    ]);
  });

  it("reads one folder once when two locations name it", async () => {
    const fs = new FakeFs();
    // A session that started in the home folder names the user subagents'
    // folder as a project's.
    fs.write(join(AGENT_MEMORY, "reviewer", "a.md"), "Check the tests.");
    const { memoryReader, sent } = reader(
      fs,
      undefined,
      claudeCodeMemoryLocations(join(HOME, ".claude"), [HOME]),
    );
    const result = await memoryReader.scan();
    expect(sent).toHaveLength(1);
    expect(result.scans?.map((scan) => scan.root)).toEqual([
      `${AGENT_MEMORY}${sep}`,
    ]);
  });

  it("reads the locations a function names, at every scan", async () => {
    const fs = new FakeFs();
    const file = join(REPO, ".claude", "agent-memory", "planner", "p.md");
    fs.write(file, "Plan in small steps.");
    let dirs: string[] = [];
    const { memoryReader, sent } = reader(fs, undefined, () =>
      claudeCodeMemoryLocations(join(HOME, ".claude"), dirs),
    );
    expect((await memoryReader.scan()).sent).toBe(0);
    dirs = [REPO];
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent[0]?.path).toBe(file);
  });

  it("lists the other locations when one cannot be listed", async () => {
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    fs.write(join(AGENT_MEMORY, "reviewer", "a.md"), "Check the tests.");
    fs.unlistable.add(join(AGENT_MEMORY, "reviewer"));
    const { memoryReader } = reader(fs);
    const result = await memoryReader.scan();
    expect(result.scans?.map((scan) => scan.root)).toEqual([
      `${PROJECTS}${sep}`,
    ]);
  });

  it("is limited to the newest project folders", () => {
    const dirs = Array.from(
      { length: MEMORY_PROJECT_DIRS_MAX + 5 },
      (_, i) => `/work/p${i}`,
    );
    // Two shared locations, then two for each project folder.
    expect(claudeCodeMemoryLocations("/cfg", dirs)).toHaveLength(
      2 + 2 * MEMORY_PROJECT_DIRS_MAX,
    );
  });
});

describe("the project folders", () => {
  it("are where each Claude Code session started and each repository it worked in, newest first, each once", () => {
    expect(
      projectDirsOf([
        { cwd: "/work/old" },
        { harness: "codex", cwd: "/work/codex" },
        {
          harness: "claude-code",
          cwd: "/work/app/packages/ui",
          baselines: { "/work/app": "abc", "/work/app-wt": "def" },
        },
        { cwd: "relative/dir" },
        { cwd: "/work/old" },
        {},
      ]),
    ).toEqual(["/work/old", "/work/app/packages/ui", "/work/app", "/work/app-wt"]);
  });

  it("stop at the limit", () => {
    const sessions = Array.from(
      { length: MEMORY_PROJECT_DIRS_MAX + 10 },
      (_, i) => ({ cwd: `/work/p${i}` }),
    );
    const dirs = projectDirsOf(sessions);
    expect(dirs).toHaveLength(MEMORY_PROJECT_DIRS_MAX);
    expect(dirs[0]).toBe(`/work/p${MEMORY_PROJECT_DIRS_MAX + 9}`);
  });
});

/** A store that answers each read with the next answer, then with the last. */
function store(...answers: MemoryStoreRead[]): MemoryStore & { reads: number } {
  const self = {
    harness: "codex" as const,
    root: "thread/",
    reads: 0,
    read: async () => {
      self.reads += 1;
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
  };
  return self;
}

const STORED = {
  path: "thread/t1",
  statement: "  Use precise date-bounded counts.  ",
  label: "github-activity",
  modifiedAt: "2026-09-27T10:00:00.000Z",
  useCount: 4,
  lastUsedAt: "2026-09-30T08:00:00.000Z",
};

describe("a store", () => {
  it("sends each memory it holds, lists it under the store's root, and hands back its count", async () => {
    const codex = store({
      kind: "read",
      memories: [
        STORED,
        { path: "thread/t0", statement: "Never used.", modifiedAt: STORED.modifiedAt, useCount: 0 },
        { path: "thread/t2", statement: "   ", modifiedAt: STORED.modifiedAt, useCount: 9 },
        { path: "other/t3", statement: "Outside the root.", modifiedAt: STORED.modifiedAt },
        { path: "thread/", statement: "No thread.", modifiedAt: STORED.modifiedAt },
      ],
    });
    const { memoryReader, sent } = reader(new FakeFs(), undefined, undefined, [codex]);

    const result = await memoryReader.scan();
    expect(sent).toEqual([
      {
        harness: "codex",
        path: "thread/t1",
        statement: "Use precise date-bounded counts.",
        label: "github-activity",
        contentDigest: digestBytes("Use precise date-bounded counts."),
        modifiedAt: "2026-09-27T10:00:00.000Z",
      },
      {
        harness: "codex",
        path: "thread/t0",
        statement: "Never used.",
        contentDigest: digestBytes("Never used."),
        modifiedAt: "2026-09-27T10:00:00.000Z",
      },
    ]);
    expect(result.scans).toEqual([
      { harness: "codex", root: "thread/", paths: ["thread/t0", "thread/t1"] },
    ]);
    // A memory with no statement is not one, so its count is not handed back.
    expect(result.counts).toEqual([
      {
        harness: "codex",
        root: "thread/",
        counts: [
          { path: "thread/t1", count: 4, lastUsedAt: "2026-09-30T08:00:00.000Z" },
          { path: "thread/t0", count: 0 },
        ],
      },
    ]);
  });

  it("does not send an unchanged memory again, and hands back its count at every scan", async () => {
    const codex = store({ kind: "read", memories: [STORED] });
    const { memoryReader, sent } = reader(new FakeFs(), undefined, undefined, [codex]);
    await memoryReader.scan();
    const again = await memoryReader.scan();
    expect(again.sent).toBe(0);
    expect(sent).toHaveLength(1);
    expect(again.counts?.[0]?.counts).toEqual([
      { path: "thread/t1", count: 4, lastUsedAt: "2026-09-30T08:00:00.000Z" },
    ]);
  });

  it("lists nothing and hands back no count when the store cannot be read, and keeps what it sent", async () => {
    const codex = store(
      { kind: "read", memories: [STORED] },
      { kind: "unavailable" },
      { kind: "read", memories: [STORED] },
    );
    const fs = new FakeFs();
    fs.write(memoryPath("-proj", "rule.md"), "Use pnpm.");
    const { memoryReader, sent } = reader(fs, undefined, undefined, [codex]);
    await memoryReader.scan();
    const locked = await memoryReader.scan();
    // The Claude Code folder is still listed.
    expect(locked.scans?.map((scan) => scan.harness)).toEqual(["claude-code"]);
    expect(locked.counts).toEqual([]);
    expect((await memoryReader.scan()).sent).toBe(0);
    expect(sent.filter((entry) => entry.harness === "codex")).toHaveLength(1);
  });

  it("lists nothing when the store is missing, and sends a memory again once it comes back", async () => {
    const codex = store(
      { kind: "read", memories: [STORED] },
      { kind: "missing" },
      { kind: "read", memories: [STORED] },
    );
    const { memoryReader, sent } = reader(new FakeFs(), undefined, undefined, [codex]);
    await memoryReader.scan();
    expect(await memoryReader.scan()).toEqual({ sent: 0, scans: [], counts: [] });
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("forgets a memory the store no longer holds", async () => {
    const codex = store(
      { kind: "read", memories: [STORED] },
      { kind: "read", memories: [] },
      { kind: "read", memories: [STORED] },
    );
    const { memoryReader, sent } = reader(new FakeFs(), undefined, undefined, [codex]);
    await memoryReader.scan();
    const gone = await memoryReader.scan();
    expect(gone.scans).toEqual([{ harness: "codex", root: "thread/", paths: [] }]);
    expect((await memoryReader.scan()).sent).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("stops at a failed send, and hands back no list and no count", async () => {
    const codex = store({ kind: "read", memories: [STORED] });
    let down = true;
    const { memoryReader } = reader(
      new FakeFs(),
      async () => {
        if (down) throw new Error("the control plane answered 503");
      },
      undefined,
      [codex],
    );
    expect(await memoryReader.scan()).toEqual({ sent: 0 });
    down = false;
    const result = await memoryReader.scan();
    expect(result.sent).toBe(1);
    expect(result.counts?.[0]?.counts).toHaveLength(1);
  });

  it("clips a stored statement and label to the limits", async () => {
    const codex = store({
      kind: "read",
      memories: [
        {
          ...STORED,
          statement: "x".repeat(MEMORY_STATEMENT_MAX_CHARS + 10),
          label: "y".repeat(MEMORY_LABEL_MAX_CHARS + 10),
        },
      ],
    });
    const { memoryReader, sent } = reader(new FakeFs(), undefined, undefined, [codex]);
    await memoryReader.scan();
    expect(sent[0]?.statement).toHaveLength(MEMORY_STATEMENT_MAX_CHARS);
    expect(sent[0]?.label).toHaveLength(MEMORY_LABEL_MAX_CHARS);
  });
});
