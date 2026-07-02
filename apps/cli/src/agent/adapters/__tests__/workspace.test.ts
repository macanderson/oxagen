/**
 * CwdWorkspace adapter — proves the engine `Workspace` port is correctly backed
 * by the local filesystem + shell: read/write/edit, directory listing, glob,
 * grep, command execution (incl. timeout + non-zero exit), and git diff.
 */
import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCwdWorkspace } from "../workspace.js";

const tmpDirs: string[] = [];

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "oxagen-ws-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await fs.mkdir(join(abs, ".."), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }
  return root;
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("createCwdWorkspace", () => {
  it("exposes its root", async () => {
    const root = await makeRepo();
    expect(createCwdWorkspace(root).root).toBe(root);
  });

  describe("readFile", () => {
    it("reads a file's full contents", async () => {
      const root = await makeRepo({ "a.txt": "hello\nworld" });
      const ws = createCwdWorkspace(root);
      expect(await ws.readFile("a.txt")).toBe("hello\nworld");
    });

    it("honors a 1-based offset + limit line range", async () => {
      const root = await makeRepo({ "n.txt": "l1\nl2\nl3\nl4\nl5" });
      const ws = createCwdWorkspace(root);
      expect(await ws.readFile("n.txt", { offset: 2, limit: 2 })).toBe("l2\nl3");
    });

    it("rejects when the file does not exist", async () => {
      const root = await makeRepo();
      const ws = createCwdWorkspace(root);
      await expect(ws.readFile("missing.txt")).rejects.toThrow();
    });
  });

  describe("writeFile", () => {
    it("creates a file and any missing parent directories", async () => {
      const root = await makeRepo();
      const ws = createCwdWorkspace(root);
      await ws.writeFile("nested/deep/x.txt", "content");
      expect(await fs.readFile(join(root, "nested/deep/x.txt"), "utf-8")).toBe("content");
    });
  });

  describe("editFile", () => {
    it("replaces a unique substring", async () => {
      const root = await makeRepo({ "e.txt": "foo bar baz" });
      const ws = createCwdWorkspace(root);
      await ws.editFile("e.txt", "bar", "QUX");
      expect(await fs.readFile(join(root, "e.txt"), "utf-8")).toBe("foo QUX baz");
    });

    it("throws when the string is not found", async () => {
      const root = await makeRepo({ "e.txt": "foo" });
      const ws = createCwdWorkspace(root);
      await expect(ws.editFile("e.txt", "missing", "x")).rejects.toThrow("not found");
    });

    it("throws when the string is not unique", async () => {
      const root = await makeRepo({ "e.txt": "x x x" });
      const ws = createCwdWorkspace(root);
      await expect(ws.editFile("e.txt", "x", "y")).rejects.toThrow("3 times");
    });
  });

  describe("list", () => {
    it("lists entries, trailing-slashing directories and skipping noise dirs", async () => {
      const root = await makeRepo({
        "file.ts": "a",
        "src/inner.ts": "b",
        "node_modules/pkg/index.js": "c",
      });
      const ws = createCwdWorkspace(root);
      const entries = await ws.list();
      expect(entries).toContain("file.ts");
      expect(entries).toContain("src/");
      expect(entries).not.toContain("node_modules/");
      // Sorted output.
      expect([...entries].sort()).toEqual(entries);
    });

    it("lists a subdirectory when given a path", async () => {
      const root = await makeRepo({ "src/a.ts": "", "src/b.ts": "" });
      const ws = createCwdWorkspace(root);
      expect(await ws.list("src")).toEqual(["a.ts", "b.ts"]);
    });
  });

  describe("glob", () => {
    it("matches files by pattern across directories, skipping noise dirs", async () => {
      const root = await makeRepo({
        "src/a.ts": "",
        "src/nested/b.ts": "",
        "src/c.js": "",
        "node_modules/d.ts": "",
      });
      const ws = createCwdWorkspace(root);
      const matches = await ws.glob("src/**/*.ts");
      expect(matches).toContain("src/a.ts");
      expect(matches).toContain("src/nested/b.ts");
      expect(matches).not.toContain("src/c.js");
      expect(matches.some((m) => m.includes("node_modules"))).toBe(false);
    });
  });

  describe("grep", () => {
    it("returns file:line:text matches", async () => {
      const root = await makeRepo({
        "one.ts": "const target = 1;\nconst other = 2;",
        "two.ts": "no match here",
      });
      const ws = createCwdWorkspace(root);
      const hits = await ws.grep("target");
      expect(hits).toHaveLength(1);
      expect(hits[0]).toBe("one.ts:1:const target = 1;");
    });

    it("restricts to a glob when given one", async () => {
      const root = await makeRepo({ "keep.ts": "needle", "skip.md": "needle" });
      const ws = createCwdWorkspace(root);
      const hits = await ws.grep("needle", { glob: "*.ts" });
      expect(hits).toEqual(["keep.ts:1:needle"]);
    });

    it("throws on an invalid regex", async () => {
      const root = await makeRepo();
      const ws = createCwdWorkspace(root);
      await expect(ws.grep("(")).rejects.toThrow("Invalid grep regex");
    });
  });

  describe("exec", () => {
    it("runs a command and returns exitCode 0 + stdout", async () => {
      const root = await makeRepo();
      const ws = createCwdWorkspace(root);
      const res = await ws.exec("echo hello");
      expect(res.exitCode).toBe(0);
      expect(res.stdout.trim()).toBe("hello");
      expect(res.timedOut).toBe(false);
    });

    it("captures a non-zero exit code and stderr", async () => {
      const root = await makeRepo();
      const ws = createCwdWorkspace(root);
      const res = await ws.exec("echo oops >&2; exit 3");
      expect(res.exitCode).toBe(3);
      expect(res.stderr.trim()).toBe("oops");
      expect(res.timedOut).toBe(false);
    });

    it("runs in the workspace root", async () => {
      const root = await makeRepo({ "marker.txt": "" });
      const ws = createCwdWorkspace(root);
      const res = await ws.exec("ls");
      expect(res.stdout).toContain("marker.txt");
    });

    it("reports timedOut when a command exceeds its timeout", async () => {
      const root = await makeRepo();
      const ws = createCwdWorkspace(root);
      const res = await ws.exec("sleep 10", { timeoutMs: 50 });
      expect(res.timedOut).toBe(true);
      expect(res.exitCode).not.toBe(0);
    });
  });

  describe("diff", () => {
    it("returns an empty string outside a git repository", async () => {
      const root = await makeRepo({ "a.txt": "x" });
      const ws = createCwdWorkspace(root);
      expect(await ws.diff()).toBe("");
    });

    it("returns a git diff for uncommitted changes", async () => {
      const root = await makeRepo({ "tracked.txt": "v1\n" });
      const ws = createCwdWorkspace(root);
      await ws.exec("git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init");
      await ws.writeFile("tracked.txt", "v2\n");
      const diff = await ws.diff();
      expect(diff).toContain("tracked.txt");
      expect(diff).toContain("+v2");
    });

    it("includes untracked (newly created) files alongside tracked changes", async () => {
      const root = await makeRepo({ "tracked.txt": "v1\n" });
      const ws = createCwdWorkspace(root);
      await ws.exec("git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init");
      // Modify a tracked file AND create a brand-new untracked file.
      await ws.writeFile("tracked.txt", "v2\n");
      await ws.writeFile("created.txt", "brand new\n");
      const diff = await ws.diff();
      // The tracked modification is still present (existing `git diff HEAD` hunk).
      expect(diff).toContain("+++ b/tracked.txt");
      expect(diff).toContain("+v2");
      // The untracked creation — invisible to `git diff HEAD` — is now included.
      expect(diff).toContain("+++ b/created.txt");
      expect(diff).toContain("+brand new");
    });

    it("skips untracked files larger than 1 MiB", async () => {
      const root = await makeRepo({ "tracked.txt": "v1\n" });
      const ws = createCwdWorkspace(root);
      await ws.exec("git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init");
      // A small untracked file is included; a >1 MiB sibling is silently skipped.
      await ws.writeFile("small.txt", "keep me\n");
      await ws.writeFile("huge.bin", "x".repeat(1024 * 1024 + 1));
      const diff = await ws.diff();
      expect(diff).toContain("+++ b/small.txt");
      expect(diff).toContain("+keep me");
      expect(diff).not.toContain("huge.bin");
    });
  });
});
