/**
 * Route–contract parity test.
 *
 * For every contract whose `surfaces` includes "api", asserts that the
 * apps/api route sources actually reference the contract — the same fact
 * `pnpm check:manifest` audits warn-only; this is the hard CI gate.
 *
 * Evidence is source-level: route files call `invoke(<contractVar>.name, …)`
 * (or embed the contract's string name in combined route files), so we scan
 * the routes directory for the contract's exported identifier or literal
 * name. The expected set comes from the contract registry — adding an
 * api-surfaced contract without a route fails CI. NON-BRITTLE: no hardcoded
 * counts, and no URL-shape assumptions — ADR-025 renamed contract names to
 * dotless verb_noun while routes keep REST-style paths, so the previous
 * name→path-substring derivation cannot work anymore.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as contractsNs from "@oxagen/oxagen/contracts";
import { contracts } from "@oxagen/oxagen/contracts";
import { getSurfaces } from "@oxagen/oxagen/types";

// ── Route source corpus ───────────────────────────────────────────────────────

const routesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) acc.push(p);
  }
  return acc;
}

const routeFiles = walk(routesDir);
const corpus = routeFiles.map((p) => readFileSync(p, "utf8")).join("\n");

// ── Contract name → exported identifier (for `invoke(<var>.name, …)`) ────────

const varByContractName = new Map<string, string>();
for (const [exportName, value] of Object.entries(contractsNs)) {
  const v = value as { name?: unknown; input?: unknown };
  if (v && typeof v.name === "string" && v.input) {
    varByContractName.set(v.name, exportName);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("route–contract parity", () => {
  const apiContracts = contracts.filter((contract) =>
    getSurfaces(contract).includes("api"),
  );

  it("there are api-surfaced contracts to check (registry is non-empty)", () => {
    expect(apiContracts.length).toBeGreaterThan(0);
  });

  it("route source corpus is non-empty", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
    expect(corpus.length).toBeGreaterThan(0);
  });

  for (const contract of contracts) {
    if (!getSurfaces(contract).includes("api")) continue;

    it(`contract "${contract.name}" is served by an apps/api route`, () => {
      const varName = varByContractName.get(contract.name);
      const needles = [
        // invoke(contractVar.name, …) — the standard route wiring
        ...(varName ? [`${varName}.name`] : []),
        // literal capability name (combined route files, dynamic dispatch)
        `"${contract.name}"`,
      ];
      const found = needles.some((needle) => corpus.includes(needle));
      expect(
        found,
        `No apps/api route references contract "${contract.name}" ` +
          `(looked for ${needles.join(" or ")} under src/routes). ` +
          `Wire a route that invokes it, or remove "api" from its surfaces.`,
      ).toBe(true);
    });
  }
});
