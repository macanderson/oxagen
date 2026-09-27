/**
 * The memory reader (`memory-reader.ts`) over an in-memory file system: what
 * it sends, what it skips, and when it sends a memory again.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestBytes } from "../../digest";
import {
  createMemoryReader,
  type HarnessMemoryLocation,
  type LocalMemoryEntry,
  MEMORY_STATEMENT_MAX_CHARS,
  type MemoryReaderFs,
} from "./memory-reader";

const HOME = "/home/dev";
const PROJECTS = join(HOME, ".claude", "projects");
const MTIME = Date.parse("2026-09-20T12:00:00.000Z");

function memoryPath(project: string, name: string): string {
  return join(PROJECTS, project, "memory", name);
}

/** A file system that holds files by path. Directories are implied. */
class FakeFs implements MemoryReaderFs {
  readonly files = new Map<string, { text: string; mtimeMs: number }>();
  /** Paths whose read rejects, as a file without read permission would. */
  readonly unreadable = new Set<string>();

  write(path: string, text: string, mtimeMs = MTIME): void {
    this.files.set(path, { text, mtimeMs });
  }

  private isDir(path: string): boolean {
    for (const file of this.files.keys())
      if (file.startsWith(`${path}/`)) return true;
    return false;
  }

  readdir = async (path: string): Promise<string[]> => {
    if (!this.isDir(path)) throw new Error(`ENOENT: ${path}`);
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
    throw new Error(`ENOENT: ${path}`);
  };

  readFile = async (path: string): Promise<string> => {
    if (this.unreadable.has(path)) throw new Error(`EACCES: ${path}`);
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`ENOENT: ${path}`);
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

    expect(await memoryReader.scan()).toEqual({ sent: 3 });
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

    expect(await memoryReader.scan()).toEqual({ sent: 1 });
    expect(sent.map((entry) => entry.path)).toEqual([
      memoryPath("-proj", "rule.md"),
    ]);
  });

  it("sends nothing when the projects folder is missing", async () => {
    const { memoryReader, sent } = reader(new FakeFs());
    expect(await memoryReader.scan()).toEqual({ sent: 0 });
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
    expect(await memoryReader.scan()).toEqual({ sent: 1 });
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
    expect(await memoryReader.scan()).toEqual({ sent: 0 });
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
    expect(await memoryReader.scan()).toEqual({ sent: 1 });
    expect(sent.map((entry) => entry.statement)).toEqual([
      "Use pnpm.",
      "Use pnpm, never npm.",
    ]);
    expect(sent[1]?.modifiedAt).toBe(new Date(MTIME + 60_000).toISOString());
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

    expect(await memoryReader.scan()).toEqual({ sent: 1 });
    expect(attempts).toEqual(["First.", "Second."]);
    down = false;
    expect(await memoryReader.scan()).toEqual({ sent: 2 });
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

    expect(await memoryReader.scan()).toEqual({ sent: 1 });
    expect(sent.map((entry) => entry.statement)).toEqual(["Open."]);
    fs.unreadable.clear();
    expect(await memoryReader.scan()).toEqual({ sent: 1 });
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
        throw new Error(`ENOENT: ${path}`);
      }
      return stat(path);
    };
    const { memoryReader, sent } = reader(fs);
    expect(await memoryReader.scan()).toEqual({ sent: 1 });
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
    expect(await first).toEqual({ sent: 1 });
    expect(await second).toEqual({ sent: 1 });
    expect(sent).toHaveLength(1);
    // Once it ends, the next scan is a new one, with nothing left to send.
    const third = memoryReader.scan();
    expect(third).not.toBe(first);
    expect(await third).toEqual({ sent: 0 });
  });
});
