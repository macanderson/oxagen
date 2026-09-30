// lint.test.ts: the rules a done record passes before anyone can lock it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  LINT_RULES,
  type EvaluatorPin,
  type EvaluatorRegistry,
  isExecutable,
  lint,
  needsNegative,
} from "./lint";
import { CHECK_KINDS, ORACLE_CLASSES, type Criterion, type DoneRecord } from "./types";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const PIN = `sha256:${"a".repeat(64)}` as EvaluatorPin;

/** A registry that knows and pins every oracle class and check kind. */
function fullRegistry(): EvaluatorRegistry {
  return {
    oracles: Object.fromEntries(ORACLE_CLASSES.map((cls) => [cls, PIN])) as EvaluatorRegistry["oracles"],
    checks: Object.fromEntries(CHECK_KINDS.map((kind) => [kind, PIN])) as EvaluatorRegistry["checks"],
  };
}

function specExample(): DoneRecord {
  const parsed = parseYaml(readFileSync(join(FIXTURES, "done-record.yaml"), "utf8")) as DoneRecord;
  const { lock: _lock, ...record } = parsed;
  return record;
}

function recordOf(criteria: Criterion[]): DoneRecord {
  return { schema: "done-record/v1", item: "wi_01K5ZQ4M8T2DXW", lineage: "aintel.platform.export", criteria };
}

function rules(record: DoneRecord, registry = fullRegistry()): string[] {
  return lint(record, registry).issues.map((issue) =>
    issue.criterion === undefined ? issue.rule : `${issue.rule}:${issue.criterion}`,
  );
}

describe("lint", () => {
  it("passes the spec's example", () => {
    expect(lint(specExample(), fullRegistry())).toEqual({ ok: true, issues: [] });
  });

  it("refuses a record with no run check and no executable oracle", () => {
    const record = recordOf([
      { id: "c1", text: "The change stays in billing.", tag: "code", check: { diff: { allow: ["src/billing/**"] } }, negative: "A change to src/auth fails." },
      { id: "c2", text: "The export writes one row per invoice.", tag: "test", oracle: { class: "predicate" } },
      { id: "c3", text: "The billing owner signs off.", tag: "review", check: { human: "sam" } },
    ]);
    const result = lint(record, fullRegistry());
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      rule: "NOTHING_TO_EXECUTE",
      message: LINT_RULES.NOTHING_TO_EXECUTE,
    });
  });

  it("accepts an executable oracle in place of a run check", () => {
    const record = recordOf([
      { id: "c1", text: "The export writes a file.", tag: "test", oracle: { class: "executable", witness: "tests/export.test.ts" } },
    ]);
    expect(rules(record)).toEqual([]);
  });

  it("asks for a negative when the text names a threshold, a boundary, or only", () => {
    const record = recordOf([
      { id: "c1", text: "The change touches only billing code.", tag: "code", check: { run: "pnpm test" } },
      { id: "c2", text: "Export finishes for 10,000 invoices.", tag: "code", check: { run: "pnpm test" }, negative: "10,001 invoices export in two pages." },
    ]);
    expect(rules(record)).toEqual(["NEGATIVE_MISSING:c1"]);
  });

  it("refuses an evaluator the registry does not know", () => {
    const registry = fullRegistry();
    delete registry.checks.run;
    delete registry.oracles.structural;
    const record = recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "c2", text: "The layout holds.", tag: "code", oracle: { class: "structural" } },
    ]);
    const result = lint(record, registry);
    expect(result.issues.map((issue) => `${issue.rule}:${issue.criterion ?? ""}`)).toEqual([
      "UNKNOWN_EVALUATOR:c1",
      "UNKNOWN_EVALUATOR:c2",
    ]);
    expect(result.issues[0]?.message).toContain("the run check");
    expect(result.issues[1]?.message).toContain("the structural oracle");
  });

  it("refuses an evaluator pinned by anything but a digest, and accepts one not built yet", () => {
    const registry = fullRegistry();
    registry.checks.run = "latest" as EvaluatorPin;
    registry.oracles.formal = null;
    const record = recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "c2", text: "The proof checks.", tag: "code", oracle: { class: "formal" } },
    ]);
    expect(rules(record, registry)).toEqual(["UNPINNED_EVALUATOR:c1"]);
  });

  it("refuses two criteria with one id", () => {
    const record = recordOf([
      { id: "c1", text: "The tests pass.", tag: "test", check: { run: "pnpm test" } },
      { id: "c1", text: "The types check.", tag: "code", check: { run: "pnpm typecheck" } },
    ]);
    expect(rules(record)).toEqual(["DUPLICATE_CRITERION:c1"]);
  });

  it("refuses more than 40 criteria", () => {
    const criteria = Array.from({ length: 41 }, (_value, index): Criterion => ({
      id: `c${index + 1}`,
      text: "The tests pass.",
      tag: "test",
      check: { run: "pnpm test" },
    }));
    expect(rules(recordOf(criteria))).toEqual(["TOO_MANY_CRITERIA"]);
  });
});

describe("needsNegative", () => {
  it.each([
    ["The change touches only billing code.", true],
    ["Only admins see the page.", true],
    ["Export finishes for 10,000 invoices.", true],
    ["Latency stays < the budget.", true],
    ["The page shows at most one screen of results.", true],
    ["The export stays under its limit.", true],
    ["The run never exceeds the budget.", true],
    ["The export finishes.", false],
    ["`pnpm test -- v2` passes.", false],
    ["Endpoint behavior matches issue #2701.", false],
  ])("%s → %s", (text, expected) => {
    expect(needsNegative(text)).toBe(expected);
  });
});

describe("isExecutable", () => {
  it("counts a run check and an executable oracle, and nothing else", () => {
    const base = { id: "c1", text: "It works.", tag: "code" } as const;
    expect(isExecutable({ ...base, check: { run: "pnpm test" } })).toBe(true);
    expect(isExecutable({ ...base, oracle: { class: "executable" } })).toBe(true);
    expect(isExecutable({ ...base, check: { file: { path: "a.ts" } }, oracle: { class: "predicate" } })).toBe(false);
    expect(isExecutable({ ...base, check: { human: "sam" } })).toBe(false);
    expect(isExecutable(base)).toBe(false);
  });
});
