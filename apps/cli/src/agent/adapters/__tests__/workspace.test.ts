/**
 * CwdWorkspace adapter — proves the engine `Workspace` port is correctly backed
 * by the local filesystem + shell: read/write/edit, directory listing, glob,
 * grep, command execution (incl. timeout + non-zero exit), and git diff.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCwdWorkspace } from "../workspace.js";
import { hasRipgrep, runRipgrep, parseRipgrepOutput } from "../ripgrep.js";

// grep prefers ripgrep when it's on PATH; mock the probe + runner so the JS-walk
// tests stay deterministic (rg IS installed on many dev/CI hosts) and the rg
// branch can be exercised with a faked backend. parseRipgrepOutput stays real.
vi.mock("../ripgrep.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ripgrep.js")>();
  return {
    ...actual,
    hasRipgrep: vi.fn(async () => false),
    runRipgrep: vi.fn(async () => ({ ok: false, stdout: "" })),
  };
});

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

beforeEach(() => {
  // Default to the JS walk; rg-branch tests opt in per test.
  vi.mocked(hasRipgrep).mockResolvedValue(false);
  vi.mocked(runRipgrep).mockResolvedValue({ ok: false, stdout: "" });
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
      expect(await ws.readFile("n.txt", { offset: 2, limit: 2 })).toBe(
        "l2\nl3",
      );
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
      expect(await fs.readFile(join(root, "nested/deep/x.txt"), "utf-8")).toBe(
        "content",
      );
    });
  });

  describe("editFile", () => {
    it("replaces a unique substring", async () => {
      const root = await makeRepo({ "e.txt": "foo bar baz" });
      const ws = createCwdWorkspace(root);
      await ws.editFile("e.txt", "bar", "QUX");
      expect(await fs.readFile(join(root, "e.txt"), "utf-8")).toBe(
        "foo QUX baz",
      );
    });

    it("throws when the string is not found", async () => {
      const root = await makeRepo({ "e.txt": "foo" });
      const ws = createCwdWorkspace(root);
      await expect(ws.editFile("e.txt", "missing", "x")).rejects.toThrow(
        "not found",
      );
    });

    it("throws when the string is not unique", async () => {
      const root = await makeRepo({ "e.txt": "x x x" });
      const ws = createCwdWorkspace(root);
      await expect(ws.editFile("e.txt", "x", "y")).rejects.toThrow("3 times");
    });

    it("returns 1 for a single replacement", async () => {
      const root = await makeRepo({ "e.txt": "foo bar baz" });
      const ws = createCwdWorkspace(root);
      expect(await ws.editFile("e.txt", "bar", "QUX")).toBe(1);
    });

    it("replaceAll replaces every occurrence and returns the count", async () => {
      const root = await makeRepo({ "e.txt": "x\nx\nx" });
      const ws = createCwdWorkspace(root);
      const n = await ws.editFile("e.txt", "x", "y", { replaceAll: true });
      expect(n).toBe(3);
      expect(await fs.readFile(join(root, "e.txt"), "utf-8")).toBe("y\ny\ny");
    });

    it("names the closest line when the string is not found", async () => {
      const root = await makeRepo({
        "e.txt": "const foo = 1;\nconst bar = 2;",
      });
      const ws = createCwdWorkspace(root);
      await expect(
        ws.editFile("e.txt", "const fooo = 1;", "x"),
      ).rejects.toThrow(/Closest match at line 1/);
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

    it("skips Python cache / *.egg-info dirs", async () => {
      const root = await makeRepo({
        "src/a.py": "",
        ".venv/lib/x.py": "",
        "pkg.egg-info/y.py": "",
      });
      const ws = createCwdWorkspace(root);
      const matches = await ws.glob("**/*.py");
      expect(matches).toContain("src/a.py");
      expect(matches.some((m) => m.includes(".venv"))).toBe(false);
      expect(matches.some((m) => m.includes("egg-info"))).toBe(false);
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

    it("uses ripgrep when available and maps its output to file:line:text", async () => {
      vi.mocked(hasRipgrep).mockResolvedValue(true);
      vi.mocked(runRipgrep).mockResolvedValue({
        ok: true,
        stdout: "src/a.ts:12:const target = 1;\nsrc/b.ts:3:target again\n",
      });
      const root = await makeRepo({ "src/a.ts": "irrelevant" });
      const ws = createCwdWorkspace(root);
      expect(await ws.grep("target")).toEqual([
        "src/a.ts:12:const target = 1;",
        "src/b.ts:3:target again",
      ]);
      // rg is invoked with an argv array (never a shell string).
      const argv = vi.mocked(runRipgrep).mock.calls[0]?.[0];
      expect(argv).toEqual(
        expect.arrayContaining([
          "--line-number",
          "--no-heading",
          "--color=never",
          "target",
        ]),
      );
    });

    it("passes --glob to ripgrep when a glob is given", async () => {
      vi.mocked(hasRipgrep).mockResolvedValue(true);
      vi.mocked(runRipgrep).mockResolvedValue({ ok: true, stdout: "" });
      const root = await makeRepo({ "a.ts": "x" });
      const ws = createCwdWorkspace(root);
      await ws.grep("x", { glob: "*.ts" });
      const argv = vi.mocked(runRipgrep).mock.calls[0]?.[0] ?? [];
      expect(argv).toEqual(expect.arrayContaining(["--glob", "*.ts"]));
    });

    it("falls back to the JS walk when ripgrep reports a failure", async () => {
      vi.mocked(hasRipgrep).mockResolvedValue(true);
      vi.mocked(runRipgrep).mockResolvedValue({ ok: false, stdout: "" });
      const root = await makeRepo({ "one.ts": "const target = 1;" });
      const ws = createCwdWorkspace(root);
      expect(await ws.grep("target")).toEqual(["one.ts:1:const target = 1;"]);
    });

    it("skips Python virtualenv / cache / *.egg-info dirs in the JS walk", async () => {
      const root = await makeRepo({
        "keep.py": "import target",
        ".venv/lib/pkg.py": "target",
        "__pycache__/mod.py": "target",
        "pkg.egg-info/PKG-INFO": "target",
        "src/real.py": "target here",
      });
      const ws = createCwdWorkspace(root);
      const files = (await ws.grep("target")).map((h) => h.split(":")[0]);
      expect(files).toContain("keep.py");
      expect(files).toContain("src/real.py");
      expect(files.some((f) => f?.includes(".venv"))).toBe(false);
      expect(files.some((f) => f?.includes("__pycache__"))).toBe(false);
      expect(files.some((f) => f?.includes("egg-info"))).toBe(false);
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
      await ws.exec(
        "git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init",
      );
      await ws.writeFile("tracked.txt", "v2\n");
      const diff = await ws.diff();
      expect(diff).toContain("tracked.txt");
      expect(diff).toContain("+v2");
    });

    it("includes untracked (newly created) files alongside tracked changes", async () => {
      const root = await makeRepo({ "tracked.txt": "v1\n" });
      const ws = createCwdWorkspace(root);
      await ws.exec(
        "git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init",
      );
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
      await ws.exec(
        "git init -q && git add -A && git -c user.email=a@b.c -c user.name=t commit -qm init",
      );
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

describe("parseRipgrepOutput", () => {
  it("parses path:line:text and preserves colons in the text column", () => {
    expect(parseRipgrepOutput("a.ts:5:const x = { y: 1 };\n")).toEqual([
      "a.ts:5:const x = { y: 1 };",
    ]);
  });

  it("strips a leading ./ from the path for parity with the JS walk", () => {
    expect(parseRipgrepOutput("./src/a.ts:1:hi\n")).toEqual(["src/a.ts:1:hi"]);
  });

  it("caps the number of hits", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `f.ts:${i + 1}:m`).join(
      "\n",
    );
    expect(parseRipgrepOutput(lines, 3)).toHaveLength(3);
  });

  it("clips the text column to 200 chars", () => {
    const [hit] = parseRipgrepOutput(`f.ts:1:${"x".repeat(300)}\n`);
    expect(hit).toBe(`f.ts:1:${"x".repeat(200)}`);
  });

  it("skips lines without at least two colons", () => {
    expect(parseRipgrepOutput("garbage line\na.ts:1:ok\n")).toEqual([
      "a.ts:1:ok",
    ]);
  });
});
