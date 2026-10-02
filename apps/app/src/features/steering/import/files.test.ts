// The files an import reads: the default target of each file (the rule
// parse_markdown_import applies, plus the dialog's own skips), the Cedar
// test that reads fences as CommonMark does, the folder a pick or a drop
// names, and the parse calls the review sends, each under 25 files and the
// server action's body limit.
import { describe, expect, it } from "vitest";
import {
  detectTarget,
  type DropDirectoryEntry,
  type DropEntry,
  type DropFileEntry,
  documentsOf,
  holdsCedar,
  IMPORT_FILES_MAX,
  type ImportDocument,
  type ImportFile,
  isMemoryFile,
  lineCount,
  parseBatches,
  parseKey,
  pickedFromDrop,
  pickedFromInput,
  readPicked,
} from "./files";

function picked(path: string, content: string) {
  const name = path.split("/").pop() ?? path;
  return { path, file: { name, text: () => Promise.resolve(content) } };
}

describe("detectTarget", () => {
  it("takes a file with a fenced cedar block as a Cedar policy", () => {
    expect(
      detectTarget(
        "no-force-push.md",
        '# No force push\n\n```cedar\nforbid (principal, action, resource);\n```\n',
      ),
    ).toEqual({ target: "policies", reason: "cedar", locked: false });
  });

  it("takes a permit or forbid statement outside every fence as a Cedar policy", () => {
    expect(
      detectTarget(
        "no-branch-delete.md",
        '# No branch delete\n\nforbid (principal, action == Action::"github__delete_branch", resource);',
      ).target,
    ).toBe("policies");
  });

  it("leaves a Cedar example inside a text fence to the records (negative)", () => {
    const md =
      "# Writing policies\n\nKeep each policy in its own file.\n\n```text\nforbid (\n  principal,\n  action,\n  resource\n);\n```\n";
    expect(holdsCedar(md)).toBe(false);
    expect(detectTarget("writing-policies.md", md).target).toBe("records");
  });

  it("reads a four-backtick fence that holds a three-backtick line as one fence", () => {
    const md = "````md\n```\nforbid (principal, action, resource);\n```\n````\n";
    expect(holdsCedar(md)).toBe(false);
  });

  it.each(["README.md", "docs/index.md", "memory/MEMORY.md"])(
    "skips %s as an index of the other files",
    (path) => {
      expect(detectTarget(path, "# Docs\n\nRead the release notes.")).toEqual({
        target: "skip",
        reason: "index",
        locked: false,
      });
    },
  );

  it("skips a file of only headings and links", () => {
    expect(
      detectTarget(
        "contents.md",
        "# Contents\n\n- [Release checklist](release-checklist.md)\n- [Retries](api/retries.md)\n",
      ),
    ).toEqual({ target: "skip", reason: "links", locked: false });
  });

  it("starts a Claude Code memory file at Memories", () => {
    const md =
      "---\nname: Release train\ndescription: Platform releases ship every other Tuesday.\nmetadata:\n  type: project\n---\n\nPlatform releases ship every other Tuesday.";
    expect(isMemoryFile(md)).toBe(true);
    expect(detectTarget("memory/project_release_train.md", md)).toEqual({
      target: "memories",
      reason: "memory",
      locked: false,
    });
  });

  it("keeps a steering-record file for the records (negative)", () => {
    const md =
      "---\nschema: steering-record/v1\nlineage: acme.billing.money\nname: Money\ndescription: Cents.\nkind: decision\n---\n\nStore money as integer cents.";
    expect(isMemoryFile(md)).toBe(false);
    expect(detectTarget("money.md", md).target).toBe("records");
  });

  it("locks out an empty file, a file over the size limit, and a path over its limit", () => {
    expect(detectTarget("empty.md", "  \n")).toEqual({
      target: "skip",
      reason: "empty",
      locked: true,
    });
    expect(detectTarget("big.md", "x".repeat(100_001))).toEqual({
      target: "skip",
      reason: "tooLarge",
      locked: true,
    });
    expect(detectTarget(`${"a/".repeat(130)}x.md`, "Use pnpm.")).toEqual({
      target: "skip",
      reason: "pathTooLong",
      locked: true,
    });
  });

  it("takes anything else as steering records", () => {
    expect(
      detectTarget("code-review.md", "# Code review\n\nKeep comments short."),
    ).toEqual({ target: "records", reason: "prose", locked: false });
  });
});

describe("readPicked", () => {
  it("reads only Markdown files, names the folder they sit in, and orders them by path", async () => {
    const read = await readPicked([
      picked("agents/worker/retries.md", "The worker retries five times."),
      picked("agents/README.md", "# Agent docs"),
      picked("agents/logo.png", "binary"),
      picked("agents/api/retries.markdown", "The API retries twice."),
    ]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.folder).toBe("agents");
    expect(read.ignored).toBe(1);
    expect(read.files.map((f) => [f.path, f.target, f.lines])).toEqual([
      ["README.md", "skip", 1],
      ["api/retries.markdown", "records", 1],
      ["worker/retries.md", "records", 1],
    ]);
  });

  it("keeps each path whole when the files sit in no one folder", async () => {
    const read = await readPicked([
      picked("CLAUDE.md", "Use pnpm."),
      picked("docs/AGENTS.md", "Run one test file."),
    ]);
    expect(read.ok && read.folder).toBeNull();
    expect(read.ok && read.files.map((f) => f.path)).toEqual([
      "CLAUDE.md",
      "docs/AGENTS.md",
    ]);
  });

  it("reads a dropped folder's entries, whose paths start with a slash", async () => {
    const read = await readPicked([
      picked("/agents/release.md", "Tag from main."),
      picked("/agents/api/retries.md", "The API retries twice."),
    ]);
    expect(read.ok && read.folder).toBe("agents");
    expect(read.ok && read.files.map((f) => f.path)).toEqual([
      "api/retries.md",
      "release.md",
    ]);
  });

  it("answers none for a pick with no Markdown file (negative)", async () => {
    expect(await readPicked([picked("logo.png", "binary")])).toEqual({
      ok: false,
      reason: "none",
    });
  });

  it("refuses more files than one import takes (negative)", async () => {
    const many = Array.from({ length: IMPORT_FILES_MAX + 1 }, (_, i) =>
      picked(`docs/f${String(i)}.md`, "Use pnpm."),
    );
    expect(await readPicked(many)).toEqual({ ok: false, reason: "tooMany" });
  });

  it("answers unreadable when the browser cannot read a file (negative)", async () => {
    expect(
      await readPicked([
        {
          path: "CLAUDE.md",
          file: { name: "CLAUDE.md", text: () => Promise.reject(new Error("gone")) },
        },
      ]),
    ).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("the browser's file lists", () => {
  it("names a folder input's file by its path inside the folder", () => {
    const file = new File(["Use pnpm."], "CLAUDE.md");
    Object.defineProperty(file, "webkitRelativePath", {
      value: "platform/CLAUDE.md",
    });
    const plain = new File(["Run one test."], "AGENTS.md");
    expect(pickedFromInput([file, plain]).map((p) => p.path)).toEqual([
      "platform/CLAUDE.md",
      "AGENTS.md",
    ]);
  });

  it("walks a dropped folder to the bottom, across every page of entries", async () => {
    const fileEntry = (fullPath: string): DropFileEntry => ({
      isFile: true,
      isDirectory: false,
      fullPath,
      file: (ok) => {
        ok(new File(["x"], fullPath.split("/").pop() ?? ""));
      },
    });
    const pages: DropEntry[][] = [
      [fileEntry("/docs/a.md")],
      [fileEntry("/docs/b.md")],
      [],
    ];
    const folder: DropDirectoryEntry = {
      isFile: false,
      isDirectory: true,
      fullPath: "/docs",
      createReader: () => ({
        readEntries: (ok) => {
          ok(pages.shift() ?? []);
        },
      }),
    };
    const drop = await pickedFromDrop({
      items: [{ webkitGetAsEntry: () => folder }],
      files: [],
    });
    expect(drop.map((p) => p.path)).toEqual(["/docs/a.md", "/docs/b.md"]);
  });

  it("takes the files of a drop that carries no entries", async () => {
    const drop = await pickedFromDrop({
      items: [{ webkitGetAsEntry: () => null }],
      files: [new File(["Use pnpm."], "CLAUDE.md")],
    });
    expect(drop.map((p) => p.path)).toEqual(["CLAUDE.md"]);
  });
});

describe("the parse calls", () => {
  const doc = (filename: string, content: string): ImportDocument => ({
    filename,
    content,
    target: "records",
  });

  it("sends at most 25 files a call", () => {
    const docs = Array.from({ length: 60 }, (_, i) =>
      doc(`f${String(i)}.md`, "Use pnpm."),
    );
    expect(parseBatches(docs).map((b) => b.length)).toEqual([25, 25, 10]);
  });

  it("starts a new call before the bytes pass the budget, and sends an oversize file alone", () => {
    const docs = [
      doc("a.md", "a".repeat(40)),
      doc("b.md", "b".repeat(40)),
      doc("c.md", "c".repeat(400)),
      doc("d.md", "d".repeat(10)),
    ];
    expect(
      parseBatches(docs, { files: 25, bytes: 200 }).map((b) =>
        b.map((d) => d.filename),
      ),
    ).toEqual([["a.md", "b.md"], ["c.md"], ["d.md"]]);
  });

  it("sends no skipped or locked file", () => {
    const file = (
      path: string,
      target: ImportFile["target"],
      locked = false,
    ): ImportFile => ({
      path,
      content: "Use pnpm.",
      lines: 1,
      target,
      reason: "prose",
      locked,
    });
    expect(
      documentsOf([
        file("a.md", "records"),
        file("b.md", "skip"),
        file("c.md", "policies"),
        file("d.md", "records", true),
        file("e.md", "memories"),
      ]),
    ).toEqual([
      { filename: "a.md", content: "Use pnpm.", target: "records" },
      { filename: "c.md", content: "Use pnpm.", target: "policies" },
      { filename: "e.md", content: "Use pnpm.", target: "memories" },
    ]);
  });

  it("keys a parse by each file and its target", () => {
    expect(parseKey([doc("a.md", "x")])).toBe(parseKey([doc("a.md", "y")]));
    expect(parseKey([doc("a.md", "x")])).not.toBe(
      parseKey([{ ...doc("a.md", "x"), target: "policies" }]),
    );
  });

  it("counts lines as an editor does", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("one\ntwo\n")).toBe(3);
  });
});
