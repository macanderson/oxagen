import { describe, expect, it } from "vitest";
import { safeReturnTo, withReturnTo } from "./return-to";

describe("safeReturnTo", () => {
  it("keeps a same-origin absolute path with its query", () => {
    const authorize =
      "/cli/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback&state=abc&code_challenge=xyz&code_challenge_method=S256&label=laptop";
    expect(safeReturnTo(authorize)).toBe(authorize);
    expect(safeReturnTo(["/a", "/b"])).toBe("/a");
  });

  it("refuses anything that could leave the origin or is not a path", () => {
    for (const bad of [
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "cli/authorize",
      "",
      "/x\r\nSet-Cookie: a=b",
      undefined,
      null,
      "/".padEnd(5000, "a"),
    ]) {
      expect(safeReturnTo(bad)).toBeNull();
    }
  });
});

describe("withReturnTo", () => {
  it("appends the parameter only when there is one", () => {
    expect(withReturnTo("/signup", null)).toBe("/signup");
    expect(withReturnTo("/signup", "/cli/authorize?state=1")).toBe(
      "/signup?returnTo=%2Fcli%2Fauthorize%3Fstate%3D1",
    );
    expect(withReturnTo("/new-organization?x=1", "/next")).toBe(
      "/new-organization?x=1&returnTo=%2Fnext",
    );
  });
});
