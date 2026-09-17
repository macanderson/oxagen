import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  declaredLayers,
  declaredName,
  derivedMissingFor,
  missingPaths,
  preservedPaths,
  referencesContractModule,
} from "./check-deregistered.mjs";

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

describe("artifacts a preserved contract declares", () => {
  // The block listed the contract for most rows and nothing else, so deleting
  // the handler, the API route or the MCP tool passed a guard whose own preamble
  // promises to preserve them (#3135, discussion_r4031534891). Listing them by
  // hand would go stale the same way, so they are derived from layers[].
  it("reads the layers a contract declares", () => {
    expect(declaredLayers('layers: ["schema", "api", "mcp", "unit"],')).toEqual(
      ["schema", "api", "mcp", "unit"],
    );
    expect(declaredLayers("no layers here")).toEqual([]);
  });

  it("reads the capability name a contract registers", () => {
    expect(declaredName('  name: "browse_plugin_catalog",')).toBe(
      "browse_plugin_catalog",
    );
    expect(declaredName("nothing")).toBeNull();
  });

  it("names the handler, route and tool a plugin-catalog contract promises", () => {
    const gone = derivedMissingFor(
      "/nowhere",
      "packages/oxagen/src/contracts/plugin.catalog.browse.ts",
      'name: "browse_plugin_catalog",\n  layers: ["schema", "api", "mcp"],',
    );
    // Nothing exists under /nowhere, so every promised artifact is reported —
    // which is the set the old guard never looked at.
    expect(gone).toEqual([
      "packages/handlers/src/plugin.catalog.browse.ts",
      "apps/api/src/routes/v1/plugin.catalog.browse.ts",
      "apps/mcp/src/tools/plugin.catalog.browse.ts",
    ]);
  });

  it("asks only for the layers the contract claims", () => {
    const gone = derivedMissingFor(
      "/nowhere",
      "packages/oxagen/src/contracts/plugin.catalog.browse.ts",
      'name: "browse_plugin_catalog",\n  layers: ["schema"],',
    );
    // A contract with no api/mcp/cli layer promises no route, tool or command;
    // the handler is unconditional because a registered capability has one.
    expect(gone).toEqual(["packages/handlers/src/plugin.catalog.browse.ts"]);
  });

  it("finds every artifact of a live contract in this repo", () => {
    const path = "packages/oxagen/src/contracts/plugin.catalog.browse.ts";
    expect(
      derivedMissingFor(
        repoRoot,
        path,
        readFileSync(join(repoRoot, path), "utf8"),
      ),
    ).toEqual([]);
  });
});

describe("referencesContractModule", () => {
  // Capability stems nest, and the scan used a bare substring test. So deleting
  // BOTH the API route and the MCP tool for `plugin.org.install` satisfied the
  // guard, because the `_bulk` sibling's own import still contained the prefix.
  // Verified by moving both files aside: the old guard exited 0 and reported
  // every artifact present.
  const bulkImport =
    'import { pluginOrgInstallBulk } from "@oxagen/oxagen/contracts/plugin.org.install_bulk";';
  const plainImport =
    'import { pluginOrgInstall } from "@oxagen/oxagen/contracts/plugin.org.install";';

  it("does NOT match a sibling whose stem extends the one asked about", () => {
    // The discriminating case. Two unrelated names would pass against the
    // broken version too, so a test using them proves nothing.
    expect(referencesContractModule(bulkImport, "plugin.org.install")).toBe(
      false,
    );
  });

  it("matches the specifier it is actually asked about", () => {
    expect(referencesContractModule(plainImport, "plugin.org.install")).toBe(
      true,
    );
    expect(
      referencesContractModule(bulkImport, "plugin.org.install_bulk"),
    ).toBe(true);
  });

  it("accepts any quote a specifier can be written with", () => {
    for (const q of ['"', "'", "`"]) {
      expect(
        referencesContractModule(
          `from ${q}x/contracts/environment.get${q}`,
          "environment.get",
        ),
      ).toBe(true);
    }
  });

  it("does not match a prefix that runs into more path", () => {
    expect(
      referencesContractModule(
        'from "x/contracts/environment.get.extra"',
        "environment.get",
      ),
    ).toBe(false);
  });

  it("finds the specifier when an earlier near-miss precedes it", () => {
    // Scanning must not stop at the first prefix hit that fails the boundary.
    expect(
      referencesContractModule(
        `${bulkImport}\n${plainImport}`,
        "plugin.org.install",
      ),
    ).toBe(true);
  });
});
