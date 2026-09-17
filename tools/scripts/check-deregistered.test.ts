import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { missingPaths, preservedPaths } from "./check-deregistered.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function ledger(block: string) {
  return `# De-registered features\n\nProse.\n\n\`\`\`preserved-paths\n${block}\n\`\`\`\n`;
}

describe("reading the preserved-paths block", () => {
  it("takes one path per line and ignores blanks and comments", () => {
    expect(
      preservedPaths(
        ledger(
          "packages/a/src/x.ts\n\n# a note\npackages/b/src\n  packages/c  ",
        ),
      ),
    ).toEqual(["packages/a/src/x.ts", "packages/b/src", "packages/c"]);
  });

  it("returns null when the ledger has no block, so the guard can say so", () => {
    expect(
      preservedPaths("# De-registered features\n\nNo block here.\n"),
    ).toBeNull();
  });

  it("does not read a fenced block of another language", () => {
    expect(preservedPaths("```text\npackages/a/src/x.ts\n```\n")).toBeNull();
  });

  it("reads only the first block, so a later example cannot smuggle paths in", () => {
    const two = `${ledger("packages/a")}\nMore prose.\n\n\`\`\`preserved-paths\npackages/b\n\`\`\`\n`;
    expect(preservedPaths(two)).toEqual(["packages/a"]);
  });
});

describe("the guard fails on a deleted path", () => {
  const exists = (p: string) => p === "packages/kept";

  it("names every path that went missing", () => {
    expect(
      missingPaths(["packages/kept", "packages/gone", "packages/also"], exists),
    ).toEqual(["packages/gone", "packages/also"]);
  });

  it("passes when every path is still there", () => {
    expect(missingPaths(["packages/kept"], exists)).toEqual([]);
  });
});

describe("the real ledger", () => {
  const markdown = readFileSync(join(repoRoot, "DEREGISTERED.md"), "utf8");

  it("carries a non-empty block, because an empty one passes vacuously", () => {
    const paths = preservedPaths(markdown);
    expect(paths).not.toBeNull();
    expect(paths!.length).toBeGreaterThan(0);
  });

  it("lists no path twice", () => {
    const paths = preservedPaths(markdown)!;
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("lists repo-relative paths only — an absolute path would never be checked", () => {
    for (const path of preservedPaths(markdown)!) {
      expect(path.startsWith("/")).toBe(false);
      expect(path.startsWith("./")).toBe(false);
    }
  });

  it("preserves the marketplace and the fourteen de-registered connectors", () => {
    const paths = preservedPaths(markdown)!;
    expect(paths).toContain(
      "apps/app/src/app/[orgSlug]/[workspaceSlug]/marketplace",
    );
    expect(paths).toContain(
      "packages/oxagen/src/contracts/plugin.org.install.ts",
    );
    for (const connector of [
      "google",
      "zoom",
      "slack",
      "salesforce",
      "microsoft",
      "stripe",
      "zendesk",
      "custom-webhook",
    ]) {
      expect(paths).toContain(`packages/ingestion/src/connectors/${connector}`);
    }
  });

  it("preserves the ingestion pipeline, which the Ontology page depends on", () => {
    expect(preservedPaths(markdown)!).toContain(
      "packages/ingestion/src/pipeline.ts",
    );
  });
});
