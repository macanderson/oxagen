import { describe, expect, it } from "vitest";
import { findHits, proseOf } from "./check-prose.mjs";

describe("check-prose", () => {
  it("flags an em dash in prose and not in code", () => {
    const md =
      "Plain — text.\n\n```sh\necho — no\n```\n\nAnd `a — b` inline.\n";
    const hits = findHits(md, ".mdx");
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  it("reads HTML entities as the dash and skips scripts and attributes", () => {
    const html =
      '<p>one &mdash; two</p><script>[{"text":"a — b"}]</script><div data-x="c — d">e</div>';
    expect(findHits(html, ".html").map((h) => h.kind)).toEqual(["em dash"]);
  });

  it("flags avoid words as whole words only", () => {
    expect(findHits("A seamless install.", ".mdx")[0].kind).toBe(
      "avoid: seamless",
    );
    expect(findHits("The severy field.", ".mdx")).toEqual([]);
  });

  it("flags the retired product name but not a citation of the document", () => {
    expect(findHits("We ship Mission Control today.", ".mdx")[0].kind).toBe(
      "avoid: Mission Control",
    );
    expect(findHits("See the Mission Control spec 14.1.", ".mdx")).toEqual([]);
    expect(findHits("See the Mission Control mockup 2821.", ".mdx")).toEqual(
      [],
    );
  });

  it("flags an exclamation point but not a shell negation", () => {
    expect(findHits("Done!", ".mdx")[0].kind).toBe("exclamation");
    expect(findHits("if [ ! -f x ]", ".mdx")).toEqual([]);
  });

  it("keeps line numbers when blanking", () => {
    expect(proseOf("a\n```\nb\n```\nc", ".mdx").split("\n").length).toBe(5);
  });
});
