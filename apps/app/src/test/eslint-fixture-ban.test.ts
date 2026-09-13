// Regression probe for the fixture-adapter ban in eslint.config.mjs. It lints
// in-memory snippets against the restriction blocks exactly as configured, so a
// spelling that slips past the ban fails here rather than in a later review.
// Type-aware rules are left out: they need real files on disk, and the ban is
// purely syntactic.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE_MESSAGE = "Only src/data/source.ts selects an adapter.";
const RESTRICTION_RULES = ["no-restricted-imports", "no-restricted-syntax"];

let eslint: ESLint;

beforeAll(async () => {
  const configUrl = pathToFileURL(path.join(appDir, "eslint.config.mjs")).href;
  const { default: config } = (await import(configUrl)) as {
    default: Linter.Config[];
  };
  const restrictionBlocks = config.flatMap((block): Linter.Config[] => {
    const rules = Object.fromEntries(
      Object.entries(block.rules ?? {}).filter(([name]) =>
        RESTRICTION_RULES.includes(name),
      ),
    );
    if (Object.keys(rules).length === 0) return [];
    return [
      {
        ...(block.files ? { files: block.files } : {}),
        ...(block.ignores ? { ignores: block.ignores } : {}),
        rules,
      },
    ];
  });
  eslint = new ESLint({
    cwd: appDir,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: { parser: tseslint.parser },
      },
      ...restrictionBlocks,
    ],
  });
}, 30_000);

async function restrictionMessages(file: string, code: string) {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(appDir, file),
  });
  if (!result) throw new Error(`no lint result for ${file}`);
  const fatal = result.messages.find((message) => message.fatal);
  if (fatal) throw new Error(`${file}: ${fatal.message}`);
  return result.messages.map((message) => message.message);
}

const isFixtureBan = (message: string) => message.includes(FIXTURE_MESSAGE);

// [importing file, source] pairs that must hit the fixture ban.
const banned: [string, string][] = [
  // Static relative and aliased spellings of the directory.
  ["src/data/probe.ts", 'import "./adapters/fixture";'],
  ["src/data/probe.ts", 'import "./adapters/fixture/x";'],
  ["src/data/probe.ts", 'import "./adapters/fixture/a/b";'],
  ["src/data/probe.ts", 'import "@/data/adapters/fixture/x";'],
  ["src/features/fleet/probe.ts", 'import "../../data/adapters/fixture";'],
  ["src/features/fleet/probe.ts", 'import "../../data/adapters/fixture/runs";'],
  // Sibling spellings from inside src/data/adapters, at every depth.
  ["src/data/adapters/probe.ts", 'import "./fixture";'],
  ["src/data/adapters/live/probe.ts", 'import "../fixture";'],
  ["src/data/adapters/live/probe.ts", 'import "../fixture/runs";'],
  ["src/data/adapters/live/mappers/runs.ts", 'import "../../fixture";'],
  ["src/data/adapters/live/mappers/runs.ts", 'import "../../fixture/runs";'],
  ["src/data/adapters/live/mappers/runs.ts", 'export * from "../../fixture";'],
  // Dynamic import(), which no-restricted-imports never sees.
  ["src/features/fleet/probe.ts", 'void import("@/data/adapters/fixture");'],
  [
    "src/features/fleet/probe.ts",
    'void import("@/data/adapters/fixture/runs");',
  ],
  [
    "src/features/fleet/probe.ts",
    'void import("../../data/adapters/fixture");',
  ],
  [
    "src/features/fleet/probe.ts",
    "const n = 'runs'; void import(`@/data/adapters/fixture/${n}`);",
  ],
  ["src/data/adapters/live/probe.ts", 'void import("../fixture");'],
  ["src/data/adapters/live/probe.ts", 'void import("../fixture/runs");'],
  ["src/data/adapters/live/mappers/runs.ts", 'void import("../../fixture");'],
  [
    "src/data/adapters/live/mappers/runs.ts",
    "const n = 'runs'; void import(`../../fixture/${n}`);",
  ],
];

// [importing file, source] pairs that must lint clean.
const allowed: [string, string][] = [
  ["src/data/source.ts", 'void import("./adapters/fixture");'],
  ["src/data/source.ts", 'import "./adapters/fixture";'],
  ["src/data/source.ts", 'import "@/data/adapters/fixture";'],
  ["src/data/adapters/fixture/runs.ts", 'import "./seed";'],
  ["src/data/adapters/fixture/runs.ts", 'void import("./seed");'],
  ["src/data/adapters/live/probe.ts", 'import "./fixture-helpers";'],
  ["src/data/adapters/live/probe.ts", 'import "./mappers/runs";'],
  ["src/data/adapters/live/probe.ts", 'void import("./mappers/runs");'],
  ["src/data/adapters/live/probe.ts", 'void import("./fixture-helpers");'],
  // Outside src/data/adapters a local `fixture` module is not the adapter.
  ["src/features/fleet/probe.ts", 'void import("./fixture");'],
];

describe("fixture-adapter lint ban", () => {
  it.each(banned)("%s: %s errors", async (file, code) => {
    const messages = await restrictionMessages(file, code);
    expect(messages.filter(isFixtureBan)).toHaveLength(1);
  });

  it.each(allowed)("%s: %s passes", async (file, code) => {
    expect(await restrictionMessages(file, code)).toEqual([]);
  });

  it("source.ts keeps the tenancy and feature-isolation bans", async () => {
    const messages = await restrictionMessages(
      "src/data/source.ts",
      'import { db } from "@oxagen/database";\nimport "@/features/fleet/internal";',
    );
    expect(messages).toHaveLength(2);
    expect(messages.some(isFixtureBan)).toBe(false);
  });
});
