/**
 * The book has one manuscript and three generated files: two editions and the
 * migration that carries them to production. These tests hold the three to the
 * manuscript, and hold the manuscript to the prose rules a script can check.
 *
 * The failure this guards is quiet. An edit to a generated edition renders
 * fine on a laptop, and an edit to the manuscript without a rebuild changes
 * nothing anywhere, so neither shows up until a reader finds a stale page in
 * production.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BANNED_WORDS,
  EDITIONS,
  MIGRATION_NAME,
  buildEditions,
  expectedOutputs,
  kickerNum,
  lintManuscript,
  lintProse,
  lintStructure,
  loadManuscript,
  readerText,
  renderChapnav,
  renderChapterNav,
  renderEditionUpdate,
  renderManifest,
  renderMigration,
  renderSection,
  scriptJson,
  stripFieldManualOnly,
  titleOf,
  unwrapFieldManualOnly,
} from "./build-book-editions.mjs";

const PART = {
  id: "p7",
  file: "p07.html",
  kind: "part",
  group: "Context engineering",
  toc: "Compression beats a bigger model",
};
const MATTER = {
  id: "kit",
  file: "kit.html",
  kind: "matter",
  mark: "▤",
  kicker: "Field kit",
  toc: "Field kit",
  title: "Field kit",
};
const COVER = {
  id: "cover",
  file: "cover.html",
  kind: "cover",
  mark: "§",
  toc: "Cover",
  title: "Cover",
};
const PART_HTML =
  '<h2 class="ch-title">Compression &amp; budgets</h2>\n<p class="ch-thesis">One line.</p>\n' +
  '<div class="todo"></div><div class="measure"></div><div class="takeaway"></div>';

describe("sections", () => {
  it("numbers a part from its id and marks front and back matter", () => {
    expect(kickerNum(PART)).toBe("Part 07");
    expect(kickerNum(MATTER)).toBe("▤");
  });

  it("reads a part's title from its heading and decodes entities", () => {
    expect(titleOf(PART, PART_HTML)).toBe("Compression & budgets");
    expect(titleOf(MATTER, "<p>no heading</p>")).toBe("Field kit");
    expect(() => titleOf(PART, "<p>no heading</p>")).toThrow(/p7/);
  });

  it("wraps a part with its kicker and leaves the cover bare", () => {
    const part = renderSection(PART, PART_HTML, { nav: "  <nav/>" });
    expect(part).toContain('<section class="ch" id="p7">');
    expect(part).toContain('<span class="num">Part 07</span>');
    expect(part).toContain("<span>Context engineering</span>");
    expect(part.trimEnd().endsWith("<nav/>\n</section>")).toBe(true);

    const cover = renderSection(COVER, "<h1>Title</h1>");
    expect(cover).toBe('<section id="cover">\n<h1>Title</h1>\n</section>');
  });

  it("links each section to the one before and the one after", () => {
    const all = [COVER, PART, MATTER];
    expect(renderChapterNav(all, 0)).toContain("<span></span><a");
    const mid = renderChapterNav(all, 1);
    expect(mid).toContain('href="#cover"');
    expect(mid).toContain('href="#kit"');
    expect(renderChapterNav(all, 2)).toContain("Part 7: Compression");
  });

  it("groups the sidebar by part group and closes with the back matter", () => {
    const nav = renderChapnav([COVER, PART, MATTER]);
    expect(nav).toContain('<div class="toc-sec">Context engineering</div>');
    expect(nav).toContain('<div class="toc-sec">Back of the book</div>');
    expect(nav).toContain('<span class="n">07</span>');
  });

  it("gives the reader a manifest entry per section", () => {
    const manifest = renderManifest([COVER, PART], {
      cover: "",
      p7: PART_HTML,
    });
    expect(manifest).toEqual([
      { id: "cover", num: "", kicker: "", title: "Cover" },
      {
        id: "p7",
        num: "PART 07",
        kicker: "CONTEXT ENGINEERING",
        title: "Compression & budgets",
      },
    ]);
  });

  it("keeps a closing script tag in a title from ending the script", () => {
    expect(scriptJson("</script>")).not.toContain("</script>");
  });
});

describe("edition-only blocks", () => {
  const html =
    '<p>a</p>\n<!-- fm-only -->\n<div class="calc"></div>\n<!-- /fm-only -->\n<p>b</p>';

  it("drops the calculator from the reader", () => {
    expect(stripFieldManualOnly(html)).toBe("<p>a</p>\n<p>b</p>");
  });

  it("keeps it in the field manual without the markers", () => {
    const out = unwrapFieldManualOnly(html);
    expect(out).toContain('<div class="calc"></div>');
    expect(out).not.toContain("fm-only");
  });
});

describe("migration", () => {
  it("updates the row for one edition and leaves published alone", () => {
    const sql = renderEditionUpdate(EDITIONS[0]!, "<p>it's a book</p>");
    expect(sql).toContain("UPDATE cms.book_editions");
    expect(sql).toContain("WHERE slug = 'field-manual';");
    expect(sql).toContain(
      "$oxagen_book_html$<p>it's a book</p>$oxagen_book_html$",
    );
    expect(sql).not.toMatch(/published/);
  });

  it("refuses HTML that contains the dollar-quote tag", () => {
    expect(() =>
      renderEditionUpdate(EDITIONS[0]!, "x $oxagen_book_html$ y"),
    ).toThrow(/dollar-quote/);
  });

  it("carries both editions", () => {
    const sql = renderMigration({
      "field-manual": "<p>a</p>",
      "page-flip-reader": "<p>b</p>",
    });
    expect(sql.match(/UPDATE cms\.book_editions/g)).toHaveLength(2);
    expect(sql).toContain("WHERE slug = 'page-flip-reader';");
  });
});

describe("prose rules", () => {
  it("reads past tags, entities and code", () => {
    const text = readerText("<p>a &amp; b <code>x != y; very</code></p>");
    expect(text).not.toContain("!=");
    expect(text).not.toContain("very");
  });

  it("flags a dash anywhere, code included", () => {
    expect(lintProse("f", "<pre><code># a — b</code></pre>")).toHaveLength(1);
    expect(lintProse("f", "<p>3–8 calls</p>")).toHaveLength(1);
  });

  it("flags an exclamation point, a semicolon and a banned word in prose", () => {
    expect(lintProse("f", "<p>Done!</p>")[0]).toMatch(/exclamation/);
    expect(lintProse("f", "<p>One; two.</p>")[0]).toMatch(/semicolon/);
    expect(lintProse("f", "<p>A robust layer.</p>")[0]).toMatch(/robust/);
    expect(lintProse("f", "<p>A robust layer.</p>", { words: false })).toEqual(
      [],
    );
  });

  it("does not flag a banned word inside a longer word", () => {
    expect(lintProse("f", "<p>Every delivery arrived.</p>")).toEqual([]);
    expect(BANNED_WORDS).toContain("very");
  });

  it("passes plain prose", () => {
    expect(lintProse("f", "<p>The parser drops framework frames.</p>")).toEqual(
      [],
    );
  });
});

describe("structure rules", () => {
  const refs = '<li id="r1"></li>';

  it("passes a part with its five blocks", () => {
    expect(lintStructure(PART, PART_HTML, refs)).toEqual([]);
  });

  it("names each block a part is missing", () => {
    const problems = lintStructure(PART, '<h2 class="ch-title">T</h2>', refs);
    expect(problems.join("\n")).toMatch(/Do this week/);
    expect(problems.join("\n")).toMatch(/Measure it/);
    expect(problems.join("\n")).toMatch(/takeaway/);
  });

  it("asks nothing of front and back matter", () => {
    expect(lintStructure(MATTER, "<p>text</p>", refs)).toEqual([]);
  });

  it("flags a bare table and passes a wrapped one", () => {
    expect(lintStructure(MATTER, "<table></table>", refs)[0]).toMatch(
      /tablewrap/,
    );
    expect(
      lintStructure(
        MATTER,
        '<div class="tablewrap"><table></table></div>',
        refs,
      ),
    ).toEqual([]);
  });

  it("flags a citation with no reference behind it", () => {
    expect(lintStructure(MATTER, '<a href="#r1">1</a>', refs)).toEqual([]);
    expect(lintStructure(MATTER, '<a href="#r99">99</a>', refs)[0]).toMatch(
      /#r99/,
    );
  });
});

describe("the committed book", () => {
  const manuscript = loadManuscript();

  it("passes the prose and structure rules", () => {
    expect(lintManuscript(manuscript)).toEqual([]);
  });

  it("has a fragment for every section and a unique id for each", () => {
    const ids = manuscript.book.sections.map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(manuscript.inners[id]).toBeTruthy();
  });

  it("numbers its parts without a gap", () => {
    const parts = manuscript.book.sections
      .filter((s: { kind: string }) => s.kind === "part")
      .map((s: { id: string }) => Number(s.id.slice(1)));
    expect(parts).toEqual(parts.map((_: number, i: number) => i + 1));
  });

  it("builds a field manual with the calculator and a reader without it", () => {
    const built = buildEditions(manuscript);
    expect(built["field-manual"]).toContain('id="calc1"');
    expect(built["page-flip-reader"]).not.toContain('id="calc1"');
    expect(built["field-manual"]).not.toContain("fm-only");
    expect(built["field-manual"]).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(built["page-flip-reader"]).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("ships no client-side redirect in the field manual", () => {
    // The migration embeds the file as built. The Node seed strips a legacy
    // gate script and the migration cannot, so the script must not exist.
    expect(buildEditions(manuscript)["field-manual"]).not.toContain(
      "ox_fm_unlocked",
    );
  });

  it("keeps the reader edits that 20260919150000 made", () => {
    const reader = buildEditions(manuscript)["page-flip-reader"];
    expect(reader).toContain("location.pathname + location.search");
    expect(reader).toContain('href="/read?e=field-manual"');
    expect(reader).not.toContain('href="/field-manual"');
  });

  it("matches the two editions and the migration on disk", () => {
    for (const { path, content } of expectedOutputs(manuscript)) {
      const onDisk = readFileSync(path, "utf8");
      expect(
        onDisk === content,
        `${path} is stale. Run node tools/scripts/build-book-editions.mjs, then rehash the migrations.`,
      ).toBe(true);
    }
    expect(MIGRATION_NAME).toMatch(/^\d{14}_book_second_edition\.sql$/);
  });
});
