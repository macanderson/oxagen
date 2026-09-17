import { describe, expect, it } from "vitest";
import { parseGitHubUrl } from "./github-url";

describe("parseGitHubUrl", () => {
  it("accepts a repository page", () => {
    const raw = "https://github.com/acme/platform";
    expect(parseGitHubUrl(raw)).toBe(raw);
  });

  it("keeps the query, because the App's install URL carries the signed state", () => {
    const raw =
      "https://github.com/apps/oxagen/installations/new?state=signed.state";
    expect(parseGitHubUrl(raw)).toBe(raw);
  });

  it("accepts the installation settings page", () => {
    const raw = "https://github.com/settings/installations/4212";
    expect(parseGitHubUrl(raw)).toBe(raw);
  });

  it("refuses a null, which is what an unconfigured deployment reports", () => {
    expect(parseGitHubUrl(null)).toBeNull();
  });

  it.each([
    ["not a URL at all", "github.com/acme/platform"],
    ["http rather than https", "http://github.com/acme/platform"],
    ["another host", "https://github.com.evil.example/acme/platform"],
    ["a lookalike subdomain", "https://raw.github.com/acme/platform"],
    ["an explicit port", "https://github.com:8443/acme/platform"],
    ["embedded credentials", "https://user:pw@github.com/acme/platform"],
    ["a fragment", "https://github.com/acme/platform#readme"],
    ["the bare host with no path", "https://github.com"],
    ["a javascript scheme", "javascript:alert(1)"],
  ])("refuses %s (negative)", (_why, raw) => {
    expect(parseGitHubUrl(raw)).toBeNull();
  });

  // A value the URL parser rewrites is not the value that was recorded, so it
  // is not linked: what a person clicks must be what the capability answered.
  it("refuses a URL the parser writes back differently (negative)", () => {
    expect(parseGitHubUrl("https://github.com/acme/../evil")).toBeNull();
  });
});
