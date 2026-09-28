/**
 * #3403: in a checkout installed with `pnpm install --filter`, a pre-push
 * check died on a module-resolution error that read exactly like a check that
 * ran and failed. The preflight must name what is missing and exit with a code
 * that no check uses, so "could not run" is never mistaken for "failed".
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CANNOT_RUN, preflight, report } from "./hook-preflight.mjs";

const ROOT = "/repo";

/** A fake checkout: file path -> contents. */
function checkout(files: Record<string, string>) {
  const map = new Map(
    Object.entries(files).map(([p, c]) => [`${ROOT}/${p}`, c]),
  );
  return {
    repoRoot: ROOT,
    read: (p: string) => {
      const c = map.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: (p: string) => map.has(p),
    loadTs: async () => ts,
  };
}

const PKG = JSON.stringify({
  scripts: {
    "check:contracts":
      "node tools/scripts/check-a.mjs && pnpm docs:schemas --check",
    "docs:schemas": "tsx tools/scripts/gen.ts",
    "check:plain": "node tools/scripts/plain.mjs",
  },
});

const SOURCES = {
  "package.json": PKG,
  "tools/scripts/check-a.mjs": 'import { readFileSync } from "node:fs";\n',
  "tools/scripts/gen.ts": [
    'import { listCapabilities } from "@oxagen/oxagen";',
    'import type { Shape } from "type-only-package";',
    'import { helper } from "./lib/helper";',
    "export const x: Shape = listCapabilities(helper);",
  ].join("\n"),
  "tools/scripts/lib/helper.ts":
    'import kleur from "kleur";\nexport const helper = kleur;\n',
  "tools/scripts/plain.mjs": 'import { join } from "node:path";\n',
};

const installed = (name: string, where = "") =>
  ({ [`${where}node_modules/${name}/package.json`]: "{}" }) as Record<
    string,
    string
  >;

describe("preflight", () => {
  it("passes when every package the script imports is installed", async () => {
    const result = await preflight(
      "check:contracts",
      checkout({
        ...SOURCES,
        ...installed("tsx"),
        ...installed("@oxagen/oxagen"),
        ...installed("kleur"),
      }),
    );
    expect(result).toEqual({ missing: [], unknownScript: false });
  });

  it("names a workspace package a filtered install left out, and the file that needs it", async () => {
    // The witness: @oxagen/oxagen absent is the #3403 checkout.
    const result = await preflight(
      "check:contracts",
      checkout({ ...SOURCES, ...installed("tsx"), ...installed("kleur") }),
    );
    expect(result.missing).toEqual([
      { name: "@oxagen/oxagen", neededBy: "tools/scripts/gen.ts" },
    ]);
  });

  it("follows relative imports into the files beside the entry", async () => {
    const result = await preflight(
      "check:contracts",
      checkout({
        ...SOURCES,
        ...installed("tsx"),
        ...installed("@oxagen/oxagen"),
      }),
    );
    expect(result.missing).toEqual([
      { name: "kleur", neededBy: "tools/scripts/lib/helper.ts" },
    ]);
  });

  it("finds a package installed beside the importing file, the way Node resolves it", async () => {
    const result = await preflight(
      "check:contracts",
      checkout({
        ...SOURCES,
        ...installed("tsx"),
        ...installed("@oxagen/oxagen", "tools/scripts/"),
        ...installed("kleur", "tools/scripts/"),
      }),
    );
    expect(result.missing).toEqual([]);
  });

  it("asks for tsx only when the script runs something under tsx", async () => {
    const withTsx = await preflight(
      "check:contracts",
      checkout({
        ...SOURCES,
        ...installed("@oxagen/oxagen"),
        ...installed("kleur"),
      }),
    );
    expect(withTsx.missing).toEqual([
      { name: "tsx", neededBy: "package.json" },
    ]);

    const plain = await preflight("check:plain", checkout(SOURCES));
    expect(plain.missing).toEqual([]);
  });

  it("does not ask for a package imported only for its types", async () => {
    const result = await preflight(
      "check:contracts",
      checkout({
        ...SOURCES,
        ...installed("tsx"),
        ...installed("@oxagen/oxagen"),
        ...installed("kleur"),
      }),
    );
    expect(result.missing.map((m) => m.name)).not.toContain(
      "type-only-package",
    );
  });

  it("reports a missing TypeScript instead of throwing a module-resolution error", async () => {
    const io = checkout(SOURCES);
    const result = await preflight("check:plain", {
      ...io,
      loadTs: async () => {
        throw new Error("Cannot find package 'typescript'");
      },
    });
    expect(result.missing).toEqual([
      { name: "typescript", neededBy: "tools/scripts/hook-preflight.mjs" },
    ]);
  });

  it("flags a script the root package.json does not define", async () => {
    const result = await preflight("check:gone", checkout(SOURCES));
    expect(result.unknownScript).toBe(true);
    expect(report("check:gone", result)).toContain('no "check:gone" script');
  });
});

describe("report", () => {
  it("says the check did not run, which package is missing, and how to fix it", () => {
    const text = report("check:contracts", {
      unknownScript: false,
      missing: [
        {
          name: "@oxagen/oxagen",
          neededBy: "tools/scripts/gen-capability-schemas.ts",
        },
      ],
    });
    expect(text).toContain("`pnpm check:contracts` could not run");
    expect(text).toContain("neither passed nor failed");
    expect(text).toContain(
      "@oxagen/oxagen is not installed (needed by tools/scripts/gen-capability-schemas.ts)",
    );
    expect(text).toContain("Run `pnpm install` at the repository root");
  });

  it("uses an exit code no check uses, so it cannot read as a failed check", () => {
    // Checks exit 1 on a finding and 2 on bad usage; 3 is reserved.
    expect(CANNOT_RUN).toBe(3);
  });
});
