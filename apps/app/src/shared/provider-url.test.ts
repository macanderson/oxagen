import { describe, expect, it } from "vitest";
import { parseProviderUrl } from "./provider-url";

describe("parseProviderUrl", () => {
  it("takes an https URL as the parser writes it", () => {
    expect(parseProviderUrl("https://linear.app")).toBe("https://linear.app/");
    expect(parseProviderUrl("https://mcp.linear.app/authorize?state=s")).toBe(
      "https://mcp.linear.app/authorize?state=s",
    );
  });

  it.each([
    "http://linear.app/",
    "javascript:alert(1)",
    "https://user:pass@linear.app/",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(parseProviderUrl(raw)).toBeNull();
  });

  it("refuses nothing given", () => {
    expect(parseProviderUrl(null)).toBeNull();
  });
});
