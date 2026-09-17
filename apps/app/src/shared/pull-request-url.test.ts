import { describe, expect, it } from "vitest";
import { parsePullRequestUrl } from "./pull-request-url";

describe("parsePullRequestUrl", () => {
  it("accepts a GitHub pull request page as written", () => {
    const raw = "https://github.com/acme/core-platform/pull/519";
    expect(parsePullRequestUrl(raw)).toBe(raw);
  });

  it.each([
    ["plain http", "http://github.com/acme/core/pull/519"],
    ["another host", "https://gitlab.com/acme/core/pull/519"],
    [
      "a host that only starts with it",
      "https://github.com.evil/acme/core/pull/1",
    ],
    ["a subdomain of it", "https://evil.github.com/acme/core/pull/1"],
    ["credentials", "https://user:pw@github.com/acme/core/pull/1"],
    ["an explicit port", "https://github.com:8443/acme/core/pull/1"],
    ["a query", "https://github.com/acme/core/pull/1?x=1"],
    ["a fragment", "https://github.com/acme/core/pull/1#files"],
    [
      "a page that is not a pull request",
      "https://github.com/acme/core/issues/1",
    ],
    [
      "a sub-page of the pull request",
      "https://github.com/acme/core/pull/1/files",
    ],
    ["pull request zero", "https://github.com/acme/core/pull/0"],
    ["a form the parser rewrites", "https://GITHUB.com/acme/core/pull/1"],
    ["dot segments", "https://github.com/acme/../evil/pull/1"],
    ["a relative path", "/acme/core/pull/1"],
    ["javascript", "javascript:alert(1)"],
    ["no URL at all", "not a url"],
  ])("refuses %s (negative)", (_case, raw) => {
    expect(parsePullRequestUrl(raw)).toBeNull();
  });
});
