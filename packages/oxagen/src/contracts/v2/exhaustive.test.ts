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
  readFileSync(join(__dirname, "fixtures/matrix.json"), "utf8"),
);

const contractFile = new Map<string, string>(
  (
    JSON.parse(
      readFileSync(join(__dirname, "fixtures/full-matrix.json"), "utf8"),
    ) as { rows: { absorbs: { name: string; file: string | null }[] }[] }
  ).rows.flatMap((r) =>
    r.absorbs
      .filter((a) => a.file)
      .map((a) => [a.name, a.file as string] as const),
  ),
);

const kebab = (n: string) => n.replace(/_/g, "-");

/**
 * The parts of a Zod schema's runtime structure this walk reads. Zod's public
 * types do not expose `_def.schema` / `_def.innerType` / `_def.options` across
 * wrapper kinds, so the walk narrows an `unknown` to just these optional keys
 * instead of treating the schema as `any`.
 */
type ZodNode = {
  shape?: Record<string, unknown>;
  element?: unknown;
  _def?: { schema?: unknown; innerType?: unknown; options?: unknown };
};

const asNode = (v: unknown): ZodNode | null =>
  typeof v === "object" && v !== null ? (v as ZodNode) : null;

/** A registered v1 contract declaration, as far as this test needs to read it. */
type ContractDecl = { name: string; input: unknown };

/**
 * Reach the object shape out of a Zod schema. A contract whose input carries a
 * `.superRefine` is a ZodEffects and has no `.shape` of its own — the object is
 * one level down. Returns null for a schema with no object shape at all (a
 * union, a bare array), which the caller reports rather than silently skips.
 */
function shapeOf(value: unknown): Record<string, unknown> | null {
  const schema = asNode(value);
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
function unionOptionsOf(value: unknown): unknown[] | null {
  const schema = asNode(value);
  if (!schema) return null;
  const options = schema._def?.options;
  if (Array.isArray(options)) return options;
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
function allKeys(
  schema: unknown,
  depth = 0,
  acc = new Set<string>(),
): Set<string> {
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

/**
 * What to do about one absorbed name, given what the source file turned out to
 * hold. Extracted so the decision is testable without building fixture
 * modules: every branch below is reachable from a plain object.
 *
 * The branch that matters is `offender`. An absorbed name that resolves to
 * nothing is either a stale descriptor or a contract that moved without its
 * references following, and both are defects. This used to `continue`
 * silently whenever the file happened to register the tool's own name, which
 * meant the check went quiet at exactly the moment it was built for — the
 * moment a contract had just been renamed. A `set_preferences` input that went
 * from nine fields to three rode straight through it.
 */
export function resolveAbsorbed(args: {
  tool: string;
  source: string;
  file: string;
  /** The absorbed v1 name still registers in that file. */
  sourceResolves: boolean;
  /** That file now registers the v2 tool's own name. */
  fileDeclaresToolName: boolean;
  /** The descriptor declares this absorption carried in place. */
  declaredInPlace: boolean;
}):
  | { kind: "compare" }
  | { kind: "carried_in_place" }
  | { kind: "offender"; message: string } {
  if (args.sourceResolves) {
    // A declaration for a name that is still there would silence a live
    // comparison — the same failure in a new coat.
    return args.declaredInPlace
      ? {
          kind: "offender",
          message: `${args.tool}: declares "${args.source}" carried in place, but ${args.source} still registers in ${args.file} — remove the declaration so the carry is compared`,
        }
      : { kind: "compare" };
  }
  if (!args.declaredInPlace) {
    return {
      kind: "offender",
      message:
        `${args.tool}: absorbed "${args.source}" resolves to nothing — ${args.file} no longer registers it, so no field was compared and this tool's carry is unproven. ` +
        `Either point \`absorbs\` at the live contract's name (right when the descriptor builds its own input, as \`set_preferences\` does), ` +
        `or declare it in \`carriedInPlace\` with a reason (right when the descriptor composes \`input: live.input\`, where a comparison would diff a schema against itself).`,
    };
  }
  // The claim is "rewritten in place under this tool's name". If the file does
  // not register that name either, the declaration does not describe reality.
  if (!args.fileDeclaresToolName) {
    return {
      kind: "offender",
      message: `${args.tool}: declares "${args.source}" carried in place, but ${args.file} registers neither "${args.source}" nor "${args.tool}" — the declaration does not describe what is in the file`,
    };
  }
  return { kind: "carried_in_place" };
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

      for (const c of tool.carriedInPlace ?? []) {
        if (!tool.absorbs.includes(c.name)) {
          offenders.push(
            `${row.name}: declares "${c.name}" carried in place, but does not absorb it`,
          );
        }
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
        const declNamed = (name: string) =>
          Object.values(srcMod).find(
            (v): v is ContractDecl =>
              typeof v === "object" &&
              v !== null &&
              (v as { name?: unknown }).name === name,
          );
        const src = declNamed(sourceName);
        const verdict = resolveAbsorbed({
          tool: row.name,
          source: sourceName,
          file,
          sourceResolves: src !== undefined,
          fileDeclaresToolName: declNamed(row.name) !== undefined,
          declaredInPlace: (tool.carriedInPlace ?? []).some(
            (c) => c.name === sourceName,
          ),
        });
        if (verdict.kind === "offender") {
          offenders.push(verdict.message);
          continue;
        }
        if (verdict.kind === "carried_in_place") continue;
        if (!src) {
          unreadable.push(
            `${row.name}: could not find "${sourceName}" in ${file}`,
          );
          continue;
        }

        const srcShape = shapeOf(src.input);
        if (!srcShape) {
          unreadable.push(
            `${row.name}: "${sourceName}" input has no object shape`,
          );
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

/**
 * The test for the test. `resolveAbsorbed` is the branch that decides whether a
 * carry is proved, excused or reported, so its own behaviour needs to be
 * pinned: the silent skip it replaces passed for months while hiding three
 * comparisons and one real field shrink. Driving the pure function directly
 * costs nothing — no fixture modules, no contracts invented for the test.
 */
describe("resolveAbsorbed", () => {
  const base = {
    tool: "set_preferences",
    source: "update_user_preferences",
    file: "user.preferences.set.ts",
    sourceResolves: false,
    fileDeclaresToolName: true,
    declaredInPlace: false,
  };

  it("compares when the absorbed name still resolves", () => {
    expect(resolveAbsorbed({ ...base, sourceResolves: true })).toEqual({
      kind: "compare",
    });
  });

  // The defect this replaces: the file registering the tool's own name used to
  // be enough to skip, silently, whatever had happened to the fields.
  it("reports an unresolvable absorbed name instead of skipping it", () => {
    const verdict = resolveAbsorbed(base);
    expect(verdict.kind).toBe("offender");
    const message = (verdict as { message: string }).message;
    expect(message).toContain("set_preferences");
    expect(message).toContain("update_user_preferences");
    expect(message).toContain("user.preferences.set.ts");
    // Both remedies, so the failure says what to do and not only what is wrong.
    expect(message).toContain("absorbs");
    expect(message).toContain("carriedInPlace");
  });

  it("excuses it once the descriptor declares the in-place carry", () => {
    expect(resolveAbsorbed({ ...base, declaredInPlace: true })).toEqual({
      kind: "carried_in_place",
    });
  });

  // Otherwise declaring becomes the new way to silence a live comparison —
  // the same failure in a new coat.
  it("refuses a declaration for a name that still resolves (negative)", () => {
    const verdict = resolveAbsorbed({
      ...base,
      sourceResolves: true,
      declaredInPlace: true,
    });
    expect(verdict.kind).toBe("offender");
    expect((verdict as { message: string }).message).toContain(
      "still registers",
    );
  });

  // The declaration claims the contract was rewritten in place under this
  // tool's name. A file holding neither name does not support that claim.
  it("refuses a declaration the file does not bear out (negative)", () => {
    const verdict = resolveAbsorbed({
      ...base,
      declaredInPlace: true,
      fileDeclaresToolName: false,
    });
    expect(verdict.kind).toBe("offender");
    expect((verdict as { message: string }).message).toContain(
      "does not describe what is in the file",
    );
  });
});
