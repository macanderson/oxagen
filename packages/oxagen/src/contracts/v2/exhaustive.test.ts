import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolV2 } from "./_define";

/**
 * Proves that every field an absorbed contract had is accounted for: either it
 * is carried on the v2 tool, or it is named in that tool's `drops`.
 *
 * `manifest.test.ts` checks that a `drops` array EXISTS. It cannot check that
 * the array is COMPLETE, because a field dropped silently leaves no trace in
 * the file to test against. That is the one way the carry can lose a production
 * edge case without anything going red — a field quietly disappears, the types
 * still check, the tests still pass, and the behaviour is gone.
 *
 * So this computes the set difference directly:
 *
 *     undeclared = keys(absorbed.input) − keys(v2.input) − drops[].field
 *
 * Anything in `undeclared` is a field that vanished without a decision.
 */

type Matrix = { name: string; resolved: string[] }[];

const MATRIX: Matrix = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../../docs/mission-control/matrix.json"),
    "utf8",
  ),
);

const contractFile = new Map<string, string>(
  (
    JSON.parse(
      readFileSync(
        join(__dirname, "../../../../../docs/mission-control/full-matrix.json"),
        "utf8",
      ),
    ) as { rows: { absorbs: { name: string; file: string | null }[] }[] }
  ).rows.flatMap((r) =>
    r.absorbs.filter((a) => a.file).map((a) => [a.name, a.file as string] as const),
  ),
);

const kebab = (n: string) => n.replace(/_/g, "-");

/**
 * Reach the object shape out of a Zod schema. A contract whose input carries a
 * `.superRefine` is a ZodEffects and has no `.shape` of its own — the object is
 * one level down. Returns null for a schema with no object shape at all (a
 * union, a bare array), which the caller reports rather than silently skips.
 */
// biome-ignore lint/suspicious/noExplicitAny: walking Zod internals by design
function shapeOf(schema: any): Record<string, unknown> | null {
  if (!schema) return null;
  if (schema.shape) return schema.shape;
  const inner = schema._def?.schema ?? schema._def?.innerType;
  if (inner) return shapeOf(inner);
  if (schema.element) return shapeOf(schema.element);
  return null;
}

/**
 * The options of a union, reached through the same wrappers `shapeOf` walks.
 *
 * A union has no shape of its own, so `shapeOf` returns null for one and every
 * field on every member reads as absent. `update_ontology` composes its six
 * absorbed mutations as `z.array(z.discriminatedUnion("op", [...]))`, each
 * member spreading that contract's own `input.shape` — thirty carried fields
 * that `allKeys` would otherwise report as silent drops, and that could then
 * only be "accounted for" by declaring drops that are not true.
 */
// biome-ignore lint/suspicious/noExplicitAny: walking Zod internals by design
function unionOptionsOf(schema: any): any[] | null {
  if (!schema) return null;
  if (Array.isArray(schema._def?.options)) return schema._def.options;
  const inner = schema._def?.schema ?? schema._def?.innerType;
  if (inner) return unionOptionsOf(inner);
  if (schema.element) return unionOptionsOf(schema.element);
  return null;
}

/**
 * Every key anywhere in a schema, at any depth.
 *
 * A carried field is allowed to move. `update_workspace` nests by policy —
 * `budget.mode` rather than a flat `mode` — because `mode` means three
 * different things across the four contracts it absorbs, and flattening would
 * force two of them to be renamed, breaking the by-import carry. Comparing only
 * top-level keys would report every such field as a silent drop.
 */
// biome-ignore lint/suspicious/noExplicitAny: walking Zod internals by design
function allKeys(schema: any, depth = 0, acc = new Set<string>()): Set<string> {
  if (depth > 4) return acc;
  // A union member's fields are carried, so walk every branch. Depth is not
  // spent here: the branches sit at the same level, not one below it.
  const options = unionOptionsOf(schema);
  if (options) {
    for (const opt of options) allKeys(opt, depth, acc);
    return acc;
  }
  const shape = shapeOf(schema);
  if (!shape) return acc;
  for (const [k, v] of Object.entries(shape)) {
    acc.add(k);
    allKeys(v, depth + 1, acc);
  }
  return acc;
}

describe("v2 carry is exhaustive", () => {
  it("no absorbed input field disappears without being declared in drops", async () => {
    const offenders: string[] = [];
    const unreadable: string[] = [];
    let compared = 0;

    for (const row of MATRIX) {
      if (row.resolved.length === 0) continue; // NEW tools absorb nothing

      const mod = await import(`./${kebab(row.name)}`);
      const tool = Object.values(mod).find(
        (v): v is ToolV2 =>
          typeof v === "object" && v !== null && "absorbs" in (v as object),
      );
      if (!tool) {
        unreadable.push(`${row.name}: no ToolV2 export`);
        continue;
      }

      const carried = allKeys(tool.input);
      const declared = new Set(tool.drops.map((d) => d.field));
      // A rename is a carry, not a loss — but only once it is written down.
      // Verify the destination exists, or `renames` becomes a way to silence
      // this check by asserting a field moved somewhere it did not.
      for (const r of tool.renames ?? []) {
        if (!carried.has(r.to)) {
          offenders.push(
            `${row.name}: declares ${r.source}.${r.from} renamed to "${r.to}", but no such field exists on its input`,
          );
          continue;
        }
        declared.add(r.from);
      }

      for (const sourceName of row.resolved) {
        const file = contractFile.get(sourceName);
        if (!file) {
          unreadable.push(`${row.name}: no file for absorbed "${sourceName}"`);
          continue;
        }
        const srcMod = await import(`../${file.replace(/\.ts$/, "")}`);
        const src = Object.values(srcMod).find(
          // biome-ignore lint/suspicious/noExplicitAny: registry declarations are untyped here
          (v: any) => v && typeof v === "object" && v.name === sourceName,
          // biome-ignore lint/suspicious/noExplicitAny: as above
        ) as any;
        if (!src) {
          unreadable.push(`${row.name}: could not find "${sourceName}" in ${file}`);
          continue;
        }

        const srcShape = shapeOf(src.input);
        if (!srcShape) {
          unreadable.push(`${row.name}: "${sourceName}" input has no object shape`);
          continue;
        }

        compared++;
        const missing = Object.keys(srcShape).filter(
          (k) => !carried.has(k) && !declared.has(k),
        );
        if (missing.length) {
          offenders.push(
            `${row.name} ← ${sourceName}: ${missing.join(", ")} (carried ${[...carried].length}, declared-dropped ${declared.size})`,
          );
        }
      }
    }

    // Surfaced, not swallowed: a source we could not read is a hole in the
    // proof, and reporting the pass without saying so would overstate it.
    expect(
      unreadable,
      `could not compare these, so they are unproven:\n  ${unreadable.join("\n  ")}`,
    ).toEqual([]);

    expect(
      offenders,
      `${compared} absorbed inputs compared. Fields that vanished without a drops entry:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);

    expect(compared).toBeGreaterThan(70);
    // 60s, not the 5s default. This one test dynamically imports every v2
    // module and every contract it absorbs — ~230 modules, each transformed by
    // vite on first touch. Warm it lands near 3s, but on a cold transform cache
    // (CI, or `vitest run src/contracts` where 184 other files compete for the
    // transform pool) it crosses 5s and fails on the clock rather than on a
    // finding. A timeout that fires on machine speed reports a carry defect
    // that is not there, and trains the reader to re-run rather than read.
  }, 60_000);
});
