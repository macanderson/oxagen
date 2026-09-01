/**
 * Coverage for OXAGEN_FORBID_TEST_EDITS: the isTestPath() classifier and the
 * edit_file/write_file denial it gates in buildWorkspaceTools. See tools.ts
 * for why this exists — SWE-bench-style grading runs hidden, fixed tests, so
 * an agent that edits the tests it's scored against "passes" locally and
 * scores 0 for real.
 */
import { describe, it, expect, afterEach } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import {
  buildWorkspaceTools,
  isTestPath,
  TEST_EDIT_DENIED_MESSAGE,
} from "./tools";

async function run(tool: unknown, input: unknown): Promise<string> {
  return (
    tool as { execute: (i: unknown, o: unknown) => Promise<string> }
  ).execute(input, {});
}

describe("isTestPath", () => {
  it.each([
    "tests/foo.ts",
    "src/tests/foo.ts",
    "test/foo.py",
    "src/test/java/com/Foo.java",
    "__tests__/foo.tsx",
    "src/__tests__/utils.ts",
    "test_foo.py",
    "foo_test.py",
    "conftest.py",
    "nested/conftest.py",
    "foo.test.ts",
    "foo.test.tsx",
    "foo.test.js",
    "foo.test.jsx",
    "foo.spec.ts",
    "foo.spec.tsx",
    "foo.spec.js",
    "foo.spec.jsx",
    "foo_spec.rb",
    "FooTest.java",
    "foo_test.go",
    "TESTS/Foo.ts", // directory match is case-insensitive
    "Foo.TEST.TS", // filename match is case-insensitive
    "FOO_SPEC.RB",
    "testing/python/integration.py", // pytest's own suite dir — escaped the guard on SWE-bench
    "src/testing/helpers.py",
  ])("matches test path: %s", (p) => {
    expect(isTestPath(p)).toBe(true);
  });

  it.each([
    "src/foo.ts",
    "packages/agent-engine/src/tools.ts",
    "attestation.go", // contains "test" but isn't the *_test.go suffix
    "contest.rb", // contains "test" but isn't the *_spec.rb suffix
    "testing-utils.ts", // "test" substring, not a `.test.` filename marker
    "protest/foo.ts", // directory named "protest" != "test" (exact match only)
  ])("does not match source path: %s", (p) => {
    expect(isTestPath(p)).toBe(false);
  });

  it("matches anywhere in an absolute path, not just repo-relative", () => {
    expect(isTestPath("/repo/src/__tests__/foo.ts")).toBe(true);
    expect(isTestPath("/repo/src/foo.ts")).toBe(false);
  });
});

describe("buildWorkspaceTools – OXAGEN_FORBID_TEST_EDITS", () => {
  afterEach(() => {
    delete process.env["OXAGEN_FORBID_TEST_EDITS"];
  });

  it("denies edit_file on a test path when the flag is set", async () => {
    process.env["OXAGEN_FORBID_TEST_EDITS"] = "1";
    const ws = new MemoryWorkspace({
      "tests/foo.test.ts": "export const x = 1;",
    });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.edit_file, {
      path: "tests/foo.test.ts",
      old_string: "1",
      new_string: "2",
    });
    expect(result).toBe(TEST_EDIT_DENIED_MESSAGE);
    expect(await ws.readFile("tests/foo.test.ts")).toBe("export const x = 1;"); // unchanged
  });

  it("denies write_file on a test path when the flag is set", async () => {
    process.env["OXAGEN_FORBID_TEST_EDITS"] = "1";
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, {
      path: "src/__tests__/new.test.ts",
      content: "// sneaky",
    });
    expect(result).toBe(TEST_EDIT_DENIED_MESSAGE);
    await expect(ws.readFile("src/__tests__/new.test.ts")).rejects.toThrow();
  });

  it("the denial message explains why, not just that it's blocked", () => {
    expect(TEST_EDIT_DENIED_MESSAGE).toMatch(/read-only/i);
    expect(TEST_EDIT_DENIED_MESSAGE).toMatch(/source/i);
  });

  it("allows edit_file on a test path when the flag is unset", async () => {
    const ws = new MemoryWorkspace({
      "tests/foo.test.ts": "export const x = 1;",
    });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.edit_file, {
      path: "tests/foo.test.ts",
      old_string: "x = 1",
      new_string: "x = 2",
    });
    expect(result).not.toBe(TEST_EDIT_DENIED_MESSAGE);
    expect(await ws.readFile("tests/foo.test.ts")).toBe("export const x = 2;");
  });

  it("allows write_file on a test path when the flag is unset", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, {
      path: "tests/new.test.ts",
      content: "// ok",
    });
    expect(result).not.toBe(TEST_EDIT_DENIED_MESSAGE);
    expect(await ws.readFile("tests/new.test.ts")).toBe("// ok");
  });

  it("allows edit_file on a source path when the flag is set", async () => {
    process.env["OXAGEN_FORBID_TEST_EDITS"] = "1";
    const ws = new MemoryWorkspace({ "src/foo.ts": "export const x = 1;" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.edit_file, {
      path: "src/foo.ts",
      old_string: "x = 1",
      new_string: "x = 2",
    });
    expect(result).not.toBe(TEST_EDIT_DENIED_MESSAGE);
    expect(await ws.readFile("src/foo.ts")).toBe("export const x = 2;");
  });

  it("allows write_file on a source path when the flag is set", async () => {
    process.env["OXAGEN_FORBID_TEST_EDITS"] = "1";
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, {
      path: "src/new.ts",
      content: "export const y = 1;",
    });
    expect(result).not.toBe(TEST_EDIT_DENIED_MESSAGE);
    expect(await ws.readFile("src/new.ts")).toBe("export const y = 1;");
  });

  it("does not restrict read_file or search on test paths when the flag is set", async () => {
    process.env["OXAGEN_FORBID_TEST_EDITS"] = "1";
    const ws = new MemoryWorkspace({ "tests/foo.test.ts": "hello" });
    const tools = buildWorkspaceTools(ws);
    const read = await run(tools.read_file, { path: "tests/foo.test.ts" });
    expect(read).toContain("hello");
    const search = await run(tools.search, { query: "hello" });
    expect(search).toContain("tests/foo.test.ts:1:hello");
  });

  it("readOnly mode still withholds write_file/edit_file regardless of the flag", () => {
    process.env["OXAGEN_FORBID_TEST_EDITS"] = "1";
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, { readOnly: true });
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit_file).toBeUndefined();
  });
});

describe("OXAGEN_FORBID_TEST_EDITS — delete_file", () => {
  it("denies deleting a test file under the flag", async () => {
    // Deleting the grading test is the same self-certification move as
    // editing it; a guard that stops one but not the other stops neither.
    process.env["OXAGEN_FORBID_TEST_EDITS"] = "1";
    try {
      const ws = new MemoryWorkspace({
        "src/a.test.ts": "test('x', () => {})",
        "src/a.ts": "export const a = 1;",
      });
      const tools = buildWorkspaceTools(ws, {}) as Record<
        string,
        { execute: (i: unknown, o?: unknown) => Promise<unknown> }
      >;
      const denied = await tools.delete_file!.execute({
        path: "src/a.test.ts",
      });
      expect(String(denied)).toContain("read-only in this mode");
      // Still there.
      await expect(ws.readFile("src/a.test.ts")).resolves.toContain("test(");
      // A source file deletes normally.
      await tools.delete_file!.execute({ path: "src/a.ts" });
      await expect(ws.readFile("src/a.ts")).rejects.toThrow();
    } finally {
      delete process.env["OXAGEN_FORBID_TEST_EDITS"];
    }
  });
});
