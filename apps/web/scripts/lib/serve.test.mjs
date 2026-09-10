import { describe, expect, it } from "vitest";
import { candidatesFor, contentTypeFor, shouldRebuild } from "./serve.mjs";

describe("contentTypeFor", () => {
  it("maps known extensions and falls back to octet-stream", () => {
    expect(contentTypeFor("/x/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
    expect(contentTypeFor("blob.unknown")).toBe("application/octet-stream");
  });
});

describe("candidatesFor", () => {
  it("applies clean-url rules the way production does", () => {
    expect(candidatesFor("/")).toEqual(["index.html"]);
    expect(candidatesFor("/blog")).toEqual(["blog/index.html", "blog.html"]);
    expect(candidatesFor("/blog/")).toEqual(["blog/index.html"]);
    expect(candidatesFor("/blog/my-post?utm=1")).toEqual([
      "blog/my-post/index.html",
      "blog/my-post.html",
    ]);
    expect(candidatesFor("/assets/blog.css")).toEqual(["assets/blog.css"]);
    expect(candidatesFor("/a%20b")).toEqual(["a b/index.html", "a b.html"]);
  });

  it("refuses traversal and malformed paths", () => {
    expect(candidatesFor("/../etc/passwd")).toEqual([]);
    expect(candidatesFor("/blog/..%2F..%2Fx")).toEqual([]);
    expect(candidatesFor("/%E0%A4%A")).toEqual([]);
    expect(candidatesFor("/a\0b")).toEqual([]);
  });
});

describe("shouldRebuild", () => {
  it("rebuilds for content, assets and pages but not for output or tooling", () => {
    expect(shouldRebuild("content/posts/x/index.mdx")).toBe(true);
    expect(shouldRebuild("assets/blog.css")).toBe(true);
    expect(shouldRebuild("index.html")).toBe(true);
    expect(shouldRebuild("products/stella/index.html")).toBe(true);
    expect(shouldRebuild("dist/blog/index.html")).toBe(false);
    expect(shouldRebuild("scripts/build.mjs")).toBe(false);
    expect(shouldRebuild("node_modules/x")).toBe(false);
    expect(shouldRebuild("assets/.DS_Store")).toBe(false);
  });
});
