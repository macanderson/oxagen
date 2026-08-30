import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubWorkspace } from "../github-workspace";
import type { GitHubClient } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    createRepoInOrg: vi.fn(),
    putFile: vi.fn(),
    forkRepo: vi.fn(),
    createBranch: vi.fn(),
    openPullRequest: vi.fn(),
    getAuthenticatedUser: vi.fn(),
    getRepoInfo: vi.fn(),
    getFileContent: vi.fn(),
    getTree: vi.fn(),
    getPullRequest: vi.fn(),
    listPullRequestComments: vi.fn(),
    listCiChecks: vi.fn(),
    listPullRequestFiles: vi.fn(),
    listBranches: vi.fn(),
    ...overrides,
  };
}

const OWNER = "acme";
const REPO = "my-repo";
const REF = "main";

function makeWorkspace(client: GitHubClient): GitHubWorkspace {
  return new GitHubWorkspace(client, { owner: OWNER, repo: REPO, ref: REF });
}

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe("readFile", () => {
  it("fetches from GitHub on first access and caches the result", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("line1\nline2\nline3"),
    });
    const ws = makeWorkspace(client);

    const result = await ws.readFile("src/index.ts");

    expect(result).toBe("line1\nline2\nline3");
    expect(client.getFileContent).toHaveBeenCalledOnce();
    expect(client.getFileContent).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      path: "src/index.ts",
      ref: REF,
    });
  });

  it("returns staged content without re-fetching after writeFile", async () => {
    const client = makeClient({
      getFileContent: vi
        .fn()
        .mockResolvedValueOnce("original content") // called by writeFile
        .mockResolvedValue(null), // should NOT be called again
    });
    const ws = makeWorkspace(client);

    await ws.writeFile("foo.ts", "staged content");
    const result = await ws.readFile("foo.ts");

    expect(result).toBe("staged content");
    // getFileContent called once by writeFile, not again by readFile
    expect(client.getFileContent).toHaveBeenCalledOnce();
  });

  it("slices lines when offset and limit are provided (1-based)", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("a\nb\nc\nd\ne"),
    });
    const ws = makeWorkspace(client);

    const result = await ws.readFile("file.ts", { offset: 2, limit: 3 });

    expect(result).toBe("b\nc\nd");
  });

  it("throws ENOENT when GitHub returns null (404)", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue(null),
    });
    const ws = makeWorkspace(client);

    await expect(ws.readFile("missing.ts")).rejects.toThrow(
      /ENOENT.*missing\.ts/,
    );
  });
});

// ---------------------------------------------------------------------------
// writeFile
// ---------------------------------------------------------------------------

describe("writeFile", () => {
  it("stages content so subsequent reads reflect it", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("original"),
    });
    const ws = makeWorkspace(client);

    await ws.writeFile("a.ts", "updated");

    expect(await ws.readFile("a.ts")).toBe("updated");
  });

  it("records the original as a new-file snapshot when GitHub returns null", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue(null),
    });
    const ws = makeWorkspace(client);

    await ws.writeFile("brand-new.ts", "export {};");

    // changedFiles should include the new file
    const changed = ws.changedFiles();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toEqual({ path: "brand-new.ts", content: "export {};" });
  });
});

// ---------------------------------------------------------------------------
// editFile
// ---------------------------------------------------------------------------

describe("editFile", () => {
  it("replaces a unique occurrence of oldString", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("const x = 1;\nconst y = 2;"),
    });
    const ws = makeWorkspace(client);

    await ws.editFile("src/a.ts", "const x = 1;", "const x = 42;");

    expect(await ws.readFile("src/a.ts")).toBe("const x = 42;\nconst y = 2;");
  });

  it("throws when oldString is not found", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("hello world"),
    });
    const ws = makeWorkspace(client);

    await expect(ws.editFile("f.ts", "not-present", "x")).rejects.toThrow(
      /not found/i,
    );
  });

  it("throws when oldString appears more than once", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("foo foo"),
    });
    const ws = makeWorkspace(client);

    await expect(ws.editFile("f.ts", "foo", "bar")).rejects.toThrow(
      /appears 2 times/,
    );
  });

  it("stages the edit so diff reflects the change", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("old"),
    });
    const ws = makeWorkspace(client);

    await ws.editFile("f.ts", "old", "new");
    const d = await ws.diff();

    expect(d).toContain("f.ts");
  });

  it("throws ENOENT when editing a non-existent file", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue(null),
    });
    const ws = makeWorkspace(client);

    await expect(ws.editFile("missing.ts", "x", "y")).rejects.toThrow(/ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  beforeEach(() => {
    // noop — per-test mocks set up inline
  });

  it("returns immediate children of the root when dir is omitted", async () => {
    const client = makeClient({
      getTree: vi
        .fn()
        .mockResolvedValue(["src/index.ts", "src/lib/util.ts", "README.md"]),
    });
    const ws = makeWorkspace(client);

    const result = await ws.list();

    expect(result.sort()).toEqual(["README.md", "src"]);
  });

  it("returns immediate children of a sub-directory", async () => {
    const client = makeClient({
      getTree: vi
        .fn()
        .mockResolvedValue([
          "src/index.ts",
          "src/lib/util.ts",
          "src/lib/helper.ts",
        ]),
    });
    const ws = makeWorkspace(client);

    const result = await ws.list("src");

    expect(result.sort()).toEqual(["index.ts", "lib"]);
  });

  it("caches the tree across multiple list calls", async () => {
    const client = makeClient({
      getTree: vi.fn().mockResolvedValue(["a.ts", "b.ts"]),
    });
    const ws = makeWorkspace(client);

    await ws.list();
    await ws.list();

    expect(client.getTree).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

describe("glob", () => {
  it("filters paths by ** pattern", async () => {
    const client = makeClient({
      getTree: vi
        .fn()
        .mockResolvedValue([
          "src/index.ts",
          "src/lib/util.ts",
          "test/foo.test.ts",
          "README.md",
        ]),
    });
    const ws = makeWorkspace(client);

    const result = await ws.glob("src/**/*.ts");

    expect(result).toEqual(["src/index.ts", "src/lib/util.ts"]);
  });

  it("matches files in the root with a simple * pattern", async () => {
    const client = makeClient({
      getTree: vi
        .fn()
        .mockResolvedValue(["index.ts", "README.md", "package.json"]),
    });
    const ws = makeWorkspace(client);

    const result = await ws.glob("*.ts");

    expect(result).toEqual(["index.ts"]);
  });

  it("returns empty array when no paths match", async () => {
    const client = makeClient({
      getTree: vi.fn().mockResolvedValue(["src/index.ts"]),
    });
    const ws = makeWorkspace(client);

    const result = await ws.glob("**/*.json");

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe("grep", () => {
  it("finds lines matching the pattern and returns path:lineNum:text", async () => {
    const client = makeClient({
      getTree: vi.fn().mockResolvedValue(["src/a.ts"]),
      getFileContent: vi
        .fn()
        .mockResolvedValue("const x = 1;\nconst FOO = 2;\nconst y = 3;"),
    });
    const ws = makeWorkspace(client);

    const hits = await ws.grep("FOO");

    expect(hits).toEqual(["src/a.ts:2:const FOO = 2;"]);
  });

  it("filters by glob option", async () => {
    const client = makeClient({
      getTree: vi.fn().mockResolvedValue(["src/a.ts", "src/b.js"]),
      getFileContent: vi.fn().mockResolvedValue("needle"),
    });
    const ws = makeWorkspace(client);

    const hits = await ws.grep("needle", { glob: "**/*.ts" });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/src\/a\.ts/);
  });

  it("caps total hits at 200", async () => {
    // 3 files, each with 100 matching lines = 300 potential hits → capped at 200
    const lines = Array.from({ length: 100 }, (_, i) => `hit ${i}`).join("\n");
    const client = makeClient({
      getTree: vi.fn().mockResolvedValue(["a.ts", "b.ts", "c.ts"]),
      getFileContent: vi.fn().mockResolvedValue(lines),
    });
    const ws = makeWorkspace(client);

    const hits = await ws.grep("hit");

    expect(hits).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------

describe("exec", () => {
  it("returns exitCode 1 with an unsupported-command error in stderr", async () => {
    const ws = makeWorkspace(makeClient());

    const result = await ws.exec("ls -la");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(
      /Command execution is not available in this API-backed GitHub workspace/,
    );
  });
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

describe("diff", () => {
  it("lists changed files in unified-diff header format", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("original"),
    });
    const ws = makeWorkspace(client);

    await ws.editFile("src/x.ts", "original", "updated");
    const d = await ws.diff();

    expect(d).toContain("--- a/src/x.ts");
    expect(d).toContain("+++ b/src/x.ts");
  });

  it("returns empty string when nothing has changed", async () => {
    const ws = makeWorkspace(makeClient());

    expect(await ws.diff()).toBe("");
  });

  it("includes new files (wrote to a path that did not exist on GitHub)", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue(null),
    });
    const ws = makeWorkspace(client);

    await ws.writeFile("new-file.ts", "export {};");
    const d = await ws.diff();

    expect(d).toContain("new-file.ts");
  });
});

// ---------------------------------------------------------------------------
// changedFiles
// ---------------------------------------------------------------------------

describe("changedFiles", () => {
  it("returns staged edits with correct path and content", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("before"),
    });
    const ws = makeWorkspace(client);

    await ws.writeFile("a.ts", "after");

    const changed = ws.changedFiles();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toEqual({ path: "a.ts", content: "after" });
  });

  it("excludes files written with the same content as on GitHub", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("same"),
    });
    const ws = makeWorkspace(client);

    await ws.writeFile("a.ts", "same");

    expect(ws.changedFiles()).toHaveLength(0);
  });

  it("includes multiple changed files", async () => {
    const client = makeClient({
      getFileContent: vi.fn().mockResolvedValue("old"),
    });
    const ws = makeWorkspace(client);

    await ws.writeFile("a.ts", "new-a");
    await ws.writeFile("b.ts", "new-b");

    const changed = ws.changedFiles();
    expect(changed).toHaveLength(2);
    const paths = changed.map((c) => c.path).sort();
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });
});

// ---------------------------------------------------------------------------
// root property
// ---------------------------------------------------------------------------

describe("root", () => {
  it("is /", () => {
    expect(makeWorkspace(makeClient()).root).toBe("/");
  });
});
