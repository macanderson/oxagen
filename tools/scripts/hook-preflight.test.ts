/**
 * #3403: in a checkout installed with `pnpm install --filter`, a pre-push
 * check died on a module-resolution error that read exactly like a check that
 * ran and failed. The preflight must name what is missing and exit with a code
 * that no check uses, so "could not run" is never mistaken for "failed".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CANNOT_RUN,
  FILTERED_INSTALL_PACKAGE,
  commandFor,
  preflight,
  report,
} from "./hook-preflight.mjs";

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

describe("preflight through a workspace package", () => {
  // A filtered install such as `pnpm install --filter @oxagen/recorder...` links
  // @oxagen/oxagen at the root and installs none of its own dependencies.
  // The preflight passed there, and `pnpm check:contracts` then died on
  // "Cannot find package 'zod'" (scratch run 36664757916).
  const links: Record<string, string> = {
    [`${ROOT}/node_modules/@oxagen/oxagen`]: `${ROOT}/packages/oxagen`,
    [`${ROOT}/packages/oxagen/node_modules/@oxagen/config`]: `${ROOT}/packages/config`,
  };
  const realpath = (p: string) => links[p] ?? p;
  const manifests = {
    "packages/oxagen/package.json": JSON.stringify({
      name: "@oxagen/oxagen",
      dependencies: { zod: "3.25.76", "@oxagen/config": "workspace:*" },
      devDependencies: { vitest: "2.1.9" },
    }),
    "packages/config/package.json": JSON.stringify({
      name: "@oxagen/config",
      dependencies: { yaml: "2.9.1" },
    }),
  };
  const linked = {
    ...SOURCES,
    ...manifests,
    ...installed("tsx"),
    ...installed("kleur"),
    ...installed("@oxagen/oxagen"),
  };
  const DECLARED = "@oxagen/oxagen, declared in packages/oxagen/package.json";

  it("names the dependencies of a linked workspace package that are not installed", async () => {
    // The witness: the #3403 checkout, where the link exists and its
    // dependencies do not.
    const result = await preflight("check:contracts", {
      ...checkout(linked),
      realpath,
    });
    expect(result.missing).toEqual([
      { name: "zod", neededBy: DECLARED },
      { name: "@oxagen/config", neededBy: DECLARED },
    ]);
    expect(report("check:contracts", result)).toContain(
      `zod is not installed (needed by ${DECLARED}).`,
    );
  });

  it("follows a workspace dependency into its own dependencies", async () => {
    const result = await preflight("check:contracts", {
      ...checkout({
        ...linked,
        ...installed("zod", "packages/oxagen/"),
        ...installed("@oxagen/config", "packages/oxagen/"),
      }),
      realpath,
    });
    expect(result.missing).toEqual([
      {
        name: "yaml",
        neededBy: "@oxagen/config, declared in packages/config/package.json",
      },
    ]);
  });

  it("passes when every declared dependency is installed, beside the package or at the root", async () => {
    const result = await preflight("check:contracts", {
      ...checkout({
        ...linked,
        ...installed("zod"),
        ...installed("@oxagen/config", "packages/oxagen/"),
        ...installed("yaml", "packages/config/"),
      }),
      realpath,
    });
    expect(result).toEqual({ missing: [], unknownScript: false });
  });

  it("does not ask for a workspace package's devDependencies, or walk an npm package", async () => {
    const result = await preflight("check:contracts", {
      ...checkout({
        ...linked,
        ...installed("zod", "packages/oxagen/"),
        ...installed("@oxagen/config", "packages/oxagen/"),
        ...installed("yaml", "packages/config/"),
        // kleur resolves inside node_modules, so it is not walked even
        // though its manifest names a dependency that is absent.
        "node_modules/kleur/package.json": JSON.stringify({
          dependencies: { absent: "1.0.0" },
        }),
      }),
      realpath,
    });
    expect(result.missing).toEqual([]);
  });
});

describe("preflight on a script file", () => {
  const FILE = "tools/scripts/typecheck-staged.mjs";
  const files = {
    ...SOURCES,
    [FILE]:
      'import ts from "typescript";\nimport { plan } from "./lib/plan.mjs";\n',
    "tools/scripts/lib/plan.mjs": 'import { join } from "node:path";\n',
  };

  it("reads a path with a script extension as a file the hook runs with node", () => {
    expect(commandFor(FILE, {})).toEqual({
      command: `node ${FILE}`,
      label: `node ${FILE}`,
    });
    expect(commandFor("tools/scripts/gen.ts", {}).command).toBe(
      "tsx tools/scripts/gen.ts",
    );
    expect(commandFor("check:contracts", { "check:contracts": "x" })).toEqual({
      command: "x",
      label: "pnpm check:contracts",
    });
  });

  it("names a missing package the file imports", async () => {
    const result = await preflight(FILE, checkout(files));
    expect(result.missing).toEqual([{ name: "typescript", neededBy: FILE }]);
    expect(report(FILE, result)).toContain(
      `\`node ${FILE}\` could not run, so it neither passed nor failed.`,
    );
  });

  it("passes when the file's imports are installed", async () => {
    const result = await preflight(
      FILE,
      checkout({ ...files, ...installed("typescript") }),
    );
    expect(result).toEqual({ missing: [], unknownScript: false });
  });

  it("flags a file that does not exist", async () => {
    const result = await preflight("tools/scripts/gone.mjs", checkout(files));
    expect(result.unknownScript).toBe(true);
    expect(report("tools/scripts/gone.mjs", result)).toContain(
      "tools/scripts/gone.mjs does not exist",
    );
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

  it("names the filtered install that works: the CLI and the root's dependency graph", () => {
    // A filtered install that adds `--filter oxagen-monorepo...` ran
    // `pnpm check:contracts` to exit 0 (scratch run 36665719175, step F5),
    // and #3403's last item names the CLI's install as the real case.
    const result = {
      unknownScript: false,
      missing: [{ name: "zod", neededBy: "@oxagen/oxagen" }],
    };
    expect(FILTERED_INSTALL_PACKAGE).toBe("@oxagen/cli");
    expect(report("check:contracts", result)).toContain(
      "`pnpm install --filter @oxagen/cli... --filter oxagen-monorepo...`",
    );
    expect(report("check:contracts", result)).toContain(
      "Add `--filter <your package>...` for the package you work on.",
    );
    expect(report("check:contracts", result, "renamed-root")).toContain(
      "--filter renamed-root...",
    );
  });

  it("names the real root package in that remedy", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = JSON.parse(
      readFileSync(join(here, "..", "..", "package.json"), "utf8"),
    );
    expect(root.name).toBe("oxagen-monorepo");
  });

  it("uses an exit code no check uses, so it cannot read as a failed check", () => {
    // Checks exit 1 on a finding and 2 on bad usage; 3 is reserved.
    expect(CANNOT_RUN).toBe(3);
  });
});
