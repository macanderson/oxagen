/**
 * ADR-216 rests on three facts outside the generators it changed. This test
 * reads the files that hold them, so a later edit that breaks one fails here
 * instead of leaving the record wrong (#3691).
 *
 * 1. `AGENTS.md` names every shared cell, so an author meets the hazard
 *    before the conflict does.
 * 2. `atlas.sum` is excluded from ADR-216 because a wrong merge resolution
 *    already fails CI: the `atlas-validate` job checks the directory hash.
 * 3. `pnpm db:lint-migrations` fails a spliced `atlas.sum` with a message
 *    that names the command that fixes it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("shared cells (ADR-216)", () => {
  it("AGENTS.md names every shared cell under Git Workflow, with the rule", () => {
    const agents = read("AGENTS.md");
    const gitWorkflow = agents.slice(
      agents.indexOf("## Git Workflow"),
      agents.indexOf("## Agent-monitored pull requests"),
    );
    const paragraph =
      gitWorkflow
        .split("\n\n")
        .find((block) => block.startsWith("**Shared cells:")) ?? "";
    expect(paragraph).toContain("regenerate from the merged tree");
    for (const cell of [
      "pnpm-lock.yaml",
      "Cargo.lock",
      "packages/database/atlas/migrations/atlas.sum",
      "packages/oxagen/capabilities.manifest.json",
      "apps/app/src/i18n/messages.d.ts",
      "packages/database/storage-manifest.json",
      "docs/capabilities/schemas/",
      "_index.json",
      "README.md",
      "ADR number",
    ]) {
      expect(paragraph, cell).toContain(cell);
    }
  });

  it("the atlas-validate job checks the migration directory's hash", () => {
    const pipeline = read(".github/workflows/pipeline.yml");
    const job = pipeline.slice(pipeline.indexOf("\n  atlas-validate:"));
    expect(job).toContain('atlas migrate validate --dir "file://atlas/migrations"');
  });

  it("db:lint-migrations tells a spliced atlas.sum to rerun atlas migrate hash", () => {
    // The source holds these inside template literals, so each backtick is
    // escaped there: `\?` accepts either form.
    const lint = read("tools/scripts/db-lint-migrations.ts");
    expect(lint).toMatch(
      /does not exist on disk \(stale\/spliced entry\) — run \\?`atlas migrate hash\\?`/,
    );
    expect(lint).toMatch(/missing from atlas\.sum — run \\?`atlas migrate hash\\?`/);
  });
});
