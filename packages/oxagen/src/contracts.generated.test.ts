import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard the auto-generated contract barrel against silent drift.
 *
 * `contracts.generated.ts` is a committed, machine-written file (by
 * tools/scripts/check_manifest.mjs). Its single `import "./contracts/<name>"`
 * per contract is what runs each contract's top-level `registerCapability()`
 * side-effect at app/runtime boot. If the committed barrel falls out of sync
 * with the contract files — a contributor adds a contract without rerunning
 * `pnpm check:manifest`, or a merge conflict on the generated file drops import
 * lines — the affected capabilities never register, and every surface that
 * dispatches them throws `Unknown capability "<name>"` at runtime even though
 * the contract, handler, API route and MCP tool all exist and their unit tests
 * pass (those import the contract module directly).
 *
 * This actually shipped: the barrel drifted to 237 imports against 256 contract
 * files, so 19 capabilities (agent.memory.delete/update/remember, org.list,
 * workspace.list, code.map, agent.feature.verify, every
 * browser.* and every agent.sandbox.*) were dead at runtime. This test fails
 * loudly on that drift so it can never silently recur.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(SRC_DIR, "contracts");
const BARREL = join(SRC_DIR, "contracts.generated.ts");

function contractFileBases(): string[] {
  return readdirSync(CONTRACTS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => f !== "index.ts")
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

function barrelImportBases(): string[] {
  const src = readFileSync(BARREL, "utf8");
  const bases: string[] = [];
  for (const m of src.matchAll(/^import\s+"\.\/contracts\/([^"]+)";$/gm)) {
    const base = m[1];
    if (base) bases.push(base);
  }
  return bases.sort();
}

describe("contracts.generated.ts barrel", () => {
  it("imports every contract file (no contract dead at runtime)", () => {
    const files = new Set(contractFileBases());
    const imported = new Set(barrelImportBases());

    const missing = [...files].filter((b) => !imported.has(b));
    const extra = [...imported].filter((b) => !files.has(b));

    expect(
      missing,
      `Contracts on disk but NOT imported by contracts.generated.ts (these capabilities will throw "Unknown capability" at runtime). Run \`pnpm check:manifest\` to regenerate the barrel.`,
    ).toEqual([]);
    expect(
      extra,
      `Barrel imports a contract file that no longer exists (dangling import). Run \`pnpm check:manifest\` to regenerate the barrel.`,
    ).toEqual([]);
  });

  it("has no duplicate imports", () => {
    const imported = barrelImportBases();
    const seen = new Set<string>();
    const dupes = imported.filter((b) =>
      seen.has(b) ? true : (seen.add(b), false),
    );
    expect(dupes, "Duplicate import lines in contracts.generated.ts").toEqual(
      [],
    );
  });
});
