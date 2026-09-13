import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Parity gate between the generated traceability matrix and the v2 tree.
 *
 * The matrix (docs/mission-control/matrix.json) is derived from Appendix E of
 * the Mission Control spec joined against the live contracts. It is the plan;
 * this directory is the execution. The two drifting silently is the failure
 * this test exists to prevent — a tool that quietly stops carrying one of its
 * sources, or a v2 file that carries something Appendix E never assigned it.
 */

type MatrixRow = {
  name: string;
  group: string;
  absorbs: string[];
  resolved: string[];
  unresolved: string[];
};

const MATRIX: MatrixRow[] = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../../docs/mission-control/matrix.json"),
    "utf8",
  ),
);

const INHERIT = MATRIX.filter(
  (r) => r.resolved.length > 0 && r.unresolved.length === 0,
);

// A v2 module is named for its tool in kebab-case: `create_workspace` lives in
// create-workspace.ts.
const fileFor = (toolName: string) => `${toolName.replace(/_/g, "-")}.ts`;

const present = new Set(
  readdirSync(__dirname).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_"),
  ),
);

describe("v2 contract manifest", () => {
  it("the matrix itself is internally consistent", () => {
    expect(MATRIX).toHaveLength(96);
    expect(INHERIT.length).toBe(74);
    expect(MATRIX.filter((r) => r.resolved.length === 0)).toHaveLength(22);
  });

  // Reported as one failure listing every gap rather than 74 separate `it`s:
  // during the carry the interesting question is "what is left", and a per-tool
  // test answers it only by making the reader count red dots.
  it("every INHERIT tool has a v2 module", () => {
    const missing = INHERIT.map((r) => r.name)
      .filter((n) => !present.has(fileFor(n)))
      .sort();

    expect(
      missing,
      `${INHERIT.length - missing.length}/${INHERIT.length} carried. Missing:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no v2 module exists that Appendix E did not assign", () => {
    const assigned = new Set(MATRIX.map((r) => fileFor(r.name)));
    const extra = [...present].filter((f) => !assigned.has(f)).sort();
    expect(extra).toEqual([]);
  });

  it("every v2 module declares what it absorbs and what it drops", async () => {
    const offenders: string[] = [];

    for (const file of [...present].sort()) {
      const src = readFileSync(join(__dirname, file), "utf8");
      const row = MATRIX.find((r) => fileFor(r.name) === file);
      if (!row) continue;

      // `absorbs` must match Appendix E exactly. A carry that drops a source
      // is a decision, and it belongs in the spec, not in a quiet edit here.
      for (const source of row.absorbs) {
        if (!src.includes(`"${source}"`)) {
          offenders.push(`${file}: does not name absorbed contract "${source}"`);
        }
      }

      // `drops: []` is a claim that nothing was dropped, and is allowed.
      // Omitting the field entirely is not — it hides the question.
      if (!/\bdrops:\s*\[/.test(src)) {
        offenders.push(`${file}: missing \`drops\` — declare [] if nothing was dropped`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
