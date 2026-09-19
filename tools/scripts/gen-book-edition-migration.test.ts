/**
 * gen-book-edition-migration.mjs renders the SQL that seeds cms.book_editions
 * for the production Atlas apply path (no Node, no seed script reaches it,
 * see the file header). These tests exercise the pure rendering functions
 * without touching the committed migration file.
 */
import { describe, expect, it } from "vitest";
import {
  BOOK_SLUG,
  DOLLAR_TAG,
  renderEditionInsert,
  renderMigration,
  rewriteFieldManualHref,
  stripLegacyGate,
} from "./gen-book-edition-migration.mjs";

const EDITION = {
  slug: "field-manual",
  file: "field-manual.html",
  format: "linear",
  title: "Engineering Deterministic AI Coding Agents \u2014 Field Manual",
};

describe("renderEditionInsert", () => {
  it("dollar-quotes the html body so internal quotes need no escaping", () => {
    const html = `<p>it's a "book"</p>`;
    const sql = renderEditionInsert(EDITION, html, "bed_fixedid0000000000000");
    expect(sql).toContain(`$${DOLLAR_TAG}$${html}$${DOLLAR_TAG}$`);
    expect(sql).toContain(`'bed_fixedid0000000000000'`);
    expect(sql).toContain(`'${EDITION.slug}'`);
    expect(sql).toContain(`'${BOOK_SLUG}'`);
    expect(sql).toContain(`'${EDITION.format}'`);
    expect(sql).toContain("ON CONFLICT (\"slug\") DO NOTHING");
  });

  it("escapes a single quote in the title for the plain-quoted literal", () => {
    const sql = renderEditionInsert(
      { ...EDITION, title: "Reader's Cut" },
      "<p>x</p>",
    );
    expect(sql).toContain("'Reader''s Cut'");
  });

  it("throws when the html body itself contains the dollar-quote tag", () => {
    expect(() =>
      renderEditionInsert(EDITION, `contains $${DOLLAR_TAG}$ literally`),
    ).toThrow(/dollar-quote tag/);
  });
});

describe("renderMigration", () => {
  it("renders one INSERT per edition, each dollar-quoted and idempotent", () => {
    const sql = renderMigration([
      { edition: EDITION, html: "<p>a</p>" },
      {
        edition: { ...EDITION, slug: "page-flip-reader", format: "page-flip" },
        html: "<p>b</p>",
      },
    ]);
    expect(sql.match(/^INSERT INTO/gm)).toHaveLength(2);
    expect(sql).toContain("'field-manual'");
    expect(sql).toContain("'page-flip-reader'");
    expect(sql.match(/ON CONFLICT \("slug"\) DO NOTHING;/g)).toHaveLength(2);
  });
});

describe("transforms mirrored from seed-book-editions.ts", () => {
  it("stripLegacyGate removes the ox_fm_unlocked redirect script only", () => {
    const html =
      '<head><script>var x = ox_fm_unlocked;</script><title>t</title></head>';
    expect(stripLegacyGate(html)).toBe("<head><title>t</title></head>");
  });

  it("rewriteFieldManualHref points the footer link at the gated reader URL", () => {
    expect(rewriteFieldManualHref('<a href="/field-manual">manual</a>')).toBe(
      '<a href="/read?e=field-manual">manual</a>',
    );
  });
});
