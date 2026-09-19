/**
 * The production database gets book edition HTML only from Atlas migrations.
 * 20260919150000 patches the page-flip reader with replace() pairs. This test
 * holds each pair to the seed asset that seedBookEditions() stores locally,
 * so the two paths cannot drift: every replacement's target text must be in
 * the asset and its source text must not.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(
    here,
    "../atlas/migrations/20260919150000_update_page_flip_reader_edition.sql",
  ),
  "utf8",
);
const asset = readFileSync(
  join(here, "../seed-assets/books/page-flip-reader.html"),
  "utf8",
);

/** Every `'from',\n'to'` literal pair passed to replace() in the migration. */
function replacePairs(sql: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const re = /\n\s*'((?:[^']|'')*)',\s*\n\s*'((?:[^']|'')*)'\s*\n\s*\)/g;
  for (const m of sql.matchAll(re)) {
    pairs.push([m[1]!.replaceAll("''", "'"), m[2]!.replaceAll("''", "'")]);
  }
  return pairs;
}

describe("20260919150000_update_page_flip_reader_edition.sql", () => {
  const pairs = replacePairs(migration);

  it("carries the three page-flip reader edits", () => {
    expect(pairs).toHaveLength(3);
  });

  it("only targets the page-flip reader row", () => {
    expect(migration).toContain("WHERE slug = 'page-flip-reader';");
  });

  it.each(pairs)("replaces %j with text the seed asset carries", (from, to) => {
    expect(asset).toContain(to);
    expect(asset).not.toContain(from);
  });
});
