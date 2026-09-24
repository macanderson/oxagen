import { describe, expect, it } from "vitest";
import { parseGitLabProjectPath } from "./project-path";

describe("parseGitLabProjectPath", () => {
  it.each([
    ["group/project", "group", "project"],
    ["a/b/c/project", "a/b/c", "project"],
    ["_group/my.project-1", "_group", "my.project-1"],
    ["Group9/Proj_X", "Group9", "Proj_X"],
  ])("accepts %s", (input, namespace, path) => {
    expect(parseGitLabProjectPath(input)).toEqual({
      namespace,
      path,
      fullPath: input,
    });
  });

  it("accepts 20 levels of subgroups plus the project", () => {
    const input = [...Array.from({ length: 21 }, (_, i) => `g${i}`)].join("/");
    expect(parseGitLabProjectPath(input)?.path).toBe("g20");
  });

  it("rejects a 22nd segment", () => {
    const input = Array.from({ length: 22 }, (_, i) => `g${i}`).join("/");
    expect(parseGitLabProjectPath(input)).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["a", "one segment"],
    ["/a/b", "leading slash"],
    ["a/b/", "trailing slash"],
    ["a//b", "empty segment"],
    ["a/../b", "dot-dot segment"],
    ["a/b..c", "dot-dot inside a segment"],
    ["a/b.git", "ends in .git"],
    ["a/b.GIT", "ends in .GIT"],
    ["a.atom/b", "ends in .atom"],
    [" a/b", "leading whitespace"],
    ["a/b ", "trailing whitespace"],
    ["-a/b", "starts with a hyphen"],
    ["a/.b", "starts with a dot"],
    ["a/b c", "contains a space"],
    ["a/b?c", "contains a question mark"],
    ["a/ü", "non-ASCII"],
  ])("rejects %j (%s)", (input) => {
    expect(parseGitLabProjectPath(input)).toBeNull();
  });

  it("rejects a segment over 255 characters", () => {
    expect(parseGitLabProjectPath(`g/${"a".repeat(256)}`)).toBeNull();
    expect(parseGitLabProjectPath(`g/${"a".repeat(255)}`)).not.toBeNull();
  });

  it("rejects a path over 1024 characters", () => {
    const seg = "a".repeat(200);
    const input = Array.from({ length: 6 }, () => seg).join("/");
    expect(input.length).toBeGreaterThan(1024);
    expect(parseGitLabProjectPath(input)).toBeNull();
  });

  it("rejects a non-string at runtime", () => {
    expect(parseGitLabProjectPath(42 as unknown as string)).toBeNull();
  });
});
