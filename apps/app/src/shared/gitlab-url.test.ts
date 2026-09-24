import { describe, expect, it } from "vitest";
import { parseGitLabUrl } from "./gitlab-url";

describe("parseGitLabUrl", () => {
  it("links a gitlab.com project, nested groups included", () => {
    for (const url of [
      "https://gitlab.com/acme/rules",
      "https://gitlab.com/acme/platform/tools/rules",
    ])
      expect(parseGitLabUrl(url)).toBe(url);
  });

  it.each([
    ["null", null],
    ["another host", "https://gitlab.example.com/acme/rules"],
    ["github", "https://github.com/acme/rules"],
    ["http", "http://gitlab.com/acme/rules"],
    ["credentials", "https://user:pw@gitlab.com/acme/rules"],
    ["a query", "https://gitlab.com/acme/rules?x=1"],
    ["a fragment", "https://gitlab.com/acme/rules#top"],
    ["a group only", "https://gitlab.com/acme"],
    ["javascript", "javascript:alert(1)"],
  ])("does not link %s", (_name, raw) => {
    expect(parseGitLabUrl(raw)).toBeNull();
  });
});
