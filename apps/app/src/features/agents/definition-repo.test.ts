// The repository a committed definition landed in, read from the pull request
// URL the commit recorded (definition-repo.ts). Anything that is not a GitHub
// pull request URL names no repository, so the page prints the branch alone.
import { describe, expect, it } from "vitest";
import { repositoryOf } from "./definition-repo";

describe("repositoryOf", () => {
  it("reads owner/repo from a GitHub pull request URL", () => {
    expect(repositoryOf("https://github.com/acme/core/pull/12")).toBe(
      "acme/core",
    );
    expect(
      repositoryOf("https://github.com/acme/core/pull/12/files#diff-1"),
    ).toBe("acme/core");
  });

  it.each([
    ["an empty string", ""],
    ["another host", "https://gitlab.com/acme/core/pull/12"],
    ["an issue, not a pull request", "https://github.com/acme/core/issues/12"],
    ["a pull request with no number", "https://github.com/acme/core/pull/"],
    ["plain http", "http://github.com/acme/core/pull/12"],
  ])("names no repository for %s (negative)", (_, url) => {
    expect(repositoryOf(url)).toBeNull();
  });
});
