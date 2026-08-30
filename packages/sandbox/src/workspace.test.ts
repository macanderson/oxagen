import { describe, expect, it } from "vitest";
import {
  isSafeWorkspacePath,
  assertSafeWorkspacePath,
  validateWorkspaceFiles,
  SandboxWorkspaceError,
  MAX_WORKSPACE_FILES,
  MAX_WORKSPACE_TOTAL_BYTES,
  MAX_WORKSPACE_PATH_LENGTH,
  WORKSPACE_ROOT,
} from "./workspace";

describe("isSafeWorkspacePath", () => {
  it("accepts a simple relative file name", () => {
    expect(isSafeWorkspacePath("main.js")).toBe(true);
  });

  it("accepts a nested relative path", () => {
    expect(isSafeWorkspacePath("src/lib/util.ts")).toBe(true);
  });

  it("accepts a dotfile and a file literally named with leading dots", () => {
    expect(isSafeWorkspacePath(".env.local")).toBe(true);
    expect(isSafeWorkspacePath("..foo")).toBe(true);
  });

  it("rejects an empty path", () => {
    expect(isSafeWorkspacePath("")).toBe(false);
  });

  it("rejects an absolute POSIX path", () => {
    expect(isSafeWorkspacePath("/etc/passwd")).toBe(false);
  });

  it("rejects a parent-traversal segment", () => {
    expect(isSafeWorkspacePath("../secret")).toBe(false);
    expect(isSafeWorkspacePath("src/../../etc/passwd")).toBe(false);
  });

  it("rejects a bare '.' or trailing-empty segment", () => {
    expect(isSafeWorkspacePath("./x")).toBe(false);
    expect(isSafeWorkspacePath("src//x")).toBe(false);
    expect(isSafeWorkspacePath("src/")).toBe(false);
  });

  it("rejects a Windows drive path and UNC/backslash path", () => {
    expect(isSafeWorkspacePath("C:\\windows")).toBe(false);
    expect(isSafeWorkspacePath("\\\\server\\share")).toBe(false);
    expect(isSafeWorkspacePath("src\\win")).toBe(false);
  });

  it("rejects a NUL byte", () => {
    expect(isSafeWorkspacePath("a\0b")).toBe(false);
  });

  it("rejects an over-long path", () => {
    expect(isSafeWorkspacePath("a".repeat(MAX_WORKSPACE_PATH_LENGTH + 1))).toBe(
      false,
    );
  });

  it("exposes the workspace root constant", () => {
    expect(WORKSPACE_ROOT).toBe("/work");
  });
});

describe("assertSafeWorkspacePath", () => {
  it("does not throw on a safe path", () => {
    expect(() => assertSafeWorkspacePath("a/b.txt")).not.toThrow();
  });

  it("throws SandboxWorkspaceError on traversal", () => {
    expect(() => assertSafeWorkspacePath("../x")).toThrow(
      SandboxWorkspaceError,
    );
  });
});

describe("validateWorkspaceFiles", () => {
  it("returns the map unchanged for valid files", () => {
    const files = { "a.js": "1", "src/b.js": "2" };
    expect(validateWorkspaceFiles(files)).toBe(files);
  });

  it("accepts an empty map", () => {
    expect(validateWorkspaceFiles({})).toEqual({});
  });

  it("throws on an unsafe path", () => {
    expect(() => validateWorkspaceFiles({ "../x": "v" })).toThrow(
      SandboxWorkspaceError,
    );
  });

  it("throws when the file count exceeds the cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_WORKSPACE_FILES; i++) files[`f${i}.txt`] = "x";
    expect(() => validateWorkspaceFiles(files)).toThrow(
      /too many workspace files/,
    );
  });

  it("respects a custom maxFiles option", () => {
    expect(() =>
      validateWorkspaceFiles({ "a.txt": "1", "b.txt": "2" }, { maxFiles: 1 }),
    ).toThrow(/too many workspace files/);
  });

  it("throws when total bytes exceed the cap", () => {
    const big = "x".repeat(MAX_WORKSPACE_TOTAL_BYTES + 1);
    expect(() => validateWorkspaceFiles({ "big.txt": big })).toThrow(/exceed/);
  });

  it("respects a custom maxTotalBytes option", () => {
    expect(() =>
      validateWorkspaceFiles({ "a.txt": "abcdef" }, { maxTotalBytes: 3 }),
    ).toThrow(/exceed/);
  });

  it("throws when content is not a string", () => {
    expect(() =>
      validateWorkspaceFiles({ "a.txt": 42 as unknown as string }),
    ).toThrow(/must be a string/);
  });
});
