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

  it("flags a retired registry line, including in JSX text", () => {
    const tsx =
      '<h2>\n  Never re-explain yourself{" "}\n  <span>to AI</span>\n</h2>';
    expect(findHits(tsx, ".tsx").map((h) => h.kind)).toEqual([
      "avoid: Never re-explain",
    ]);
  });

  // Every one of these came back on a customer page after the registry retired
  // it, three of them inside one pull request, which is why the scanner holds
  // them rather than a reviewer.
  it("flags each retired line the registry names, phrase and all", () => {
    for (const [text, kind] of [
      ["Fewer tokens, same answers.", "avoid: Fewer tokens, same answers"],
      ["Stop wasting money on AI.", "avoid: Stop wasting money"],
      ["Can you explain your AI bill?", "avoid: explain your AI bill"],
      [
        "Mission Control for your autonomous agents.",
        "avoid: Mission Control for your autonomous agents",
      ],
    ] as const) {
      expect(findHits(text, ".mdx").map((h) => h.kind)).toContain(kind);
    }
  });

  it("flags an unqualified key-custody claim", () => {
    for (const [text, kind] of [
      ["The agent never sees the key.", "avoid: The agent never sees the key"],
      ["The key never moves.", "avoid: The key never moves"],
      [
        "There is nothing for the agent to leak.",
        "avoid: nothing for the agent to leak",
      ],
    ] as const) {
      expect(findHits(text, ".html").map((h) => h.kind)).toContain(kind);
    }
  });

  // The mediated-connection wording positioning.md requires must not trip the
  // scanner that exists to enforce it.
  it("leaves the mediated-connection custody line alone", () => {
    expect(
      findHits(
        "For a mediated connection, the agent does not receive the credential.",
        ".html",
      ),
    ).toEqual([]);
    expect(
      findHits("The agent never receives a connection credential.", ".html"),
    ).toEqual([]);
  });

  // The approved replacement must not trip the scanner, or the fix for one of
  // these findings would fail the gate that exists to enforce it.
  it("leaves the approved headline alone", () => {
    expect(
      findHits("Workforce management for autonomous agents.", ".mdx"),
    ).toEqual([]);
    expect(
      findHits(
        "Your agents are a workforce now. Manage them like one.",
        ".mdx",
      ),
    ).toEqual([]);
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

  it("flags the retired savings-without-measurement line", () => {
    const html = "<strong>Fewer tokens, same answers.</strong>";
    expect(findHits(html, ".html").map((h) => h.kind)).toEqual([
      "avoid: Fewer tokens, same answers",
    ]);
  });

  // A deck's narration lives in exported data in script-data.js, which is why
  // .js cannot borrow the .tsx handling: that branch blanks `export` lines as
  // module plumbing, and the spoken script is on them.
  it("reads a deck's narration out of exported data, and ignores its comments", () => {
    const js = [
      "/* a header comment with an em dash \u2014 not read aloud */",
      'export const SCRIPT = [{ say: "Mission Control for your autonomous agents." }];',
    ].join("\n");
    expect(findHits(js, ".js").map((h) => h.kind)).toEqual([
      "avoid: Mission Control for your autonomous agents",
    ]);
  });

  it("flags an exclamation point but not a shell negation", () => {
    expect(findHits("Done!", ".mdx")[0].kind).toBe("exclamation");
    expect(findHits("if [ ! -f x ]", ".mdx")).toEqual([]);
  });

  it("keeps line numbers when blanking", () => {
    expect(proseOf("a\n```\nb\n```\nc", ".mdx").split("\n").length).toBe(5);
  });
});
