/**
 * use-server-type-export-invariant.test.ts — structural guard against a
 * runtime-only "use server" footgun.
 *
 * Next.js compiles every named export of a `"use server"` module into a
 * callable server reference via the flight loader:
 *
 *   registerServerReference(<export>, "<action-id>", null);
 *
 * That assumes every export is a real runtime value (an async function). The
 * TYPE-ONLY LOCAL re-export form is NOT stripped before this pass runs in
 * Next 16.x + Turbopack, so the erased type name leaks into the action
 * manifest and gets registered as if it were an action:
 *
 *   // fanout-actions.ts
 *   import type { AgentSubagentFanoutListOutput } from "...";
 *   export type { AgentSubagentFanoutListOutput };   // ← LOCAL form, BUG
 *
 *   // compiled output:
 *   registerServerReference(AgentSubagentFanoutListOutput, "7f01...", null);
 *   // → ReferenceError: AgentSubagentFanoutListOutput is not defined
 *   //   at module evaluation
 *
 * Because that crash happens at module-eval time and the module is pulled in by
 * the Wand chat shell (rendered in OrgLayout on every /[orgSlug]/... page), one
 * bad re-export takes down the entire org shell at runtime — yet it passes
 * typecheck, lint, AND ordinary unit tests (vitest uses its own transform, not
 * the flight loader). This bit `fanout-actions.ts` and `prompt-settings-action.ts`.
 *
 * The FROM-SOURCE re-export form is stripped correctly and is safe:
 *
 *   export type { AgentSubagentFanoutListOutput } from "...";  // ← safe
 *
 * Rule: a `"use server"` module must never use the local type re-export form.
 * Either add a `from "<module>"` clause (re-export from source) or move the
 * type to its contract module and let consumers import it from there.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...collectSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

const HAS_USE_SERVER = /(^|\n)\s*["']use server["']\s*;?/;

/**
 * Returns every TYPE-ONLY LOCAL re-export found in `source` — i.e.
 * `export type { ... }` with NO `from "<module>"` clause. The from-source form
 * (with a `from` clause) is the safe one and is excluded.
 */
function localTypeReExports(source: string): string[] {
  // Collapse whitespace so a multi-line `export type {\n A,\n B\n} from "m"`
  // is matched as one statement.
  const flattened = source.replace(/\s+/g, " ");
  const re = /export\s+type\s*\{[^}]*\}\s*(from\s*['"][^'"]+['"])?/g;
  const offenders: string[] = [];
  for (let m = re.exec(flattened); m !== null; m = re.exec(flattened)) {
    if (!m[1]) offenders.push(m[0].trim());
  }
  return offenders;
}

describe('"use server" type-export invariant', () => {
  const files = collectSourceFiles(SRC_DIR);

  it("scans a non-empty source tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("distinguishes the dangerous local form from the safe from-source form", () => {
    // Dangerous: local block re-export (no `from`) → flight loader registers it.
    expect(localTypeReExports("export type { Foo, Bar };")).toEqual([
      "export type { Foo, Bar }",
    ]);
    // Safe: re-export straight from a module is stripped before the action pass.
    expect(localTypeReExports('export type { Foo } from "m";')).toEqual([]);
    // Safe: a plain type-alias declaration is never a re-export.
    expect(localTypeReExports("export type Foo = Bar;")).toEqual([]);
    // Mixed file: only the local form is flagged.
    expect(
      localTypeReExports('export type { A } from "m";\nexport type { B };'),
    ).toEqual(["export type { B }"]);
  });

  it('no "use server" module uses the local type re-export form', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!HAS_USE_SERVER.test(source)) continue;
      const bad = localTypeReExports(source);
      if (bad.length > 0) {
        offenders.push(`${relative(SRC_DIR, file)} → ${bad.join("; ")}`);
      }
    }
    expect(
      offenders,
      `These "use server" modules use the local type re-export form, which ` +
        `Next's flight loader mis-registers as a server action (ReferenceError ` +
        `at module evaluation). Add a \`from "<module>"\` clause or move the ` +
        `type to its contract module:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
