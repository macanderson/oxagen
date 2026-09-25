/**
 * The guard for #2978: an ADR that merges without an entry in
 * `docs/adr/README.md` is a decision no reader can find.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deadIndexLinks,
  indexedFiles,
  missingFromIndex,
} from "./check-adr-index.mjs";

const README = [
  "# Architecture Decision Records",
  "",
  "- [ADR-001](./ADR-001-drizzle.md) — Drizzle as Postgres ORM",
  "- [ADR-002](ADR-002-inngest.md#context) — Inngest, linked without ./",
  "- ADR-003 is mentioned here in prose, with no link.",
].join("\n");

describe("indexedFiles", () => {
  it("reads link targets with or without ./ and drops the fragment", () => {
    expect([...indexedFiles(README)].sort()).toEqual([
      "ADR-001-drizzle.md",
      "ADR-002-inngest.md",
    ]);
  });
});

describe("missingFromIndex", () => {
  it("returns nothing when every ADR file is linked", () => {
    expect(
      missingFromIndex(["ADR-002-inngest.md", "ADR-001-drizzle.md"], README),
    ).toEqual([]);
  });

  it("names an ADR file the README does not link", () => {
    expect(
      missingFromIndex(
        ["ADR-001-drizzle.md", "ADR-004-new.md", "ADR-002-inngest.md"],
        README,
      ),
    ).toEqual(["ADR-004-new.md"]);
  });

  it("does not count a bare id in prose as an index entry", () => {
    expect(
      missingFromIndex(
        ["ADR-001-drizzle.md", "ADR-002-inngest.md", "ADR-003-neo4j.md"],
        README,
      ),
    ).toEqual(["ADR-003-neo4j.md"]);
  });

  it("ignores README.md and files that are not ADRs", () => {
    expect(
      missingFromIndex(
        ["README.md", "notes.txt", "ADR-001-drizzle.md", "ADR-002-inngest.md"],
        README,
      ),
    ).toEqual([]);
  });
});

describe("deadIndexLinks", () => {
  it("names a link whose ADR file does not exist", () => {
    expect(deadIndexLinks(["ADR-001-drizzle.md"], README)).toEqual([
      "ADR-002-inngest.md",
    ]);
  });
});

describe("the repository's ADR index", () => {
  it("links every ADR in docs/adr and no missing file", () => {
    const adrDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "docs",
      "adr",
    );
    const files = readdirSync(adrDir);
    const readme = readFileSync(join(adrDir, "README.md"), "utf8");
    expect(missingFromIndex(files, readme)).toEqual([]);
    expect(deadIndexLinks(files, readme)).toEqual([]);
  });
});
