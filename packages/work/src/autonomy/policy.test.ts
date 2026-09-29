import { readFileSync } from "node:fs";
import { type CedarRuntime, requireCedarRuntime, writeCedarSchema } from "@oxagen/policy";
import { parse as parseToml } from "smol-toml";
import { beforeAll, describe, expect, it } from "vitest";
import type { AutonomyEntry, WorkFile } from "../types";
import { AUTONOMY_CEDAR_SCHEMA } from "./cedar-schema";
import {
  AUTONOMY_FORBIDS,
  AUTONOMY_POLICY_PATH,
  HIGH_RISK_FORBID_ID,
  RISK_UNKNOWN_FORBID_ID,
  commentSafe,
  generateAutonomyPolicy,
  permitId,
  policiesForScope,
} from "./policy";

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
});

const FIXTURE = new URL("../../fixtures/work.toml", import.meta.url);

function fixtureWork(): WorkFile {
  return parseToml(readFileSync(FIXTURE, "utf8")) as unknown as WorkFile;
}

function entry(overrides: Partial<AutonomyEntry> = {}): AutonomyEntry {
  return { scope: { label: "Documentation" }, level: 2, operator: "priya", ...overrides };
}

/** Validate a policy set, as text or by id, in strict mode. */
function validate(policies: string | Record<string, string>, schema = AUTONOMY_CEDAR_SCHEMA) {
  return runtime.validate({ validationSettings: { mode: "strict" }, schema, policies: { staticPolicies: policies } });
}

/** How many policies Cedar reads in the text. */
function policyCount(text: string): number {
  const parts = runtime.policySetTextToParts(text);
  if (parts.type === "failure") throw new Error(parts.errors.map((e) => e.message).join("; "));
  return parts.policies.length;
}

describe("generateAutonomyPolicy", () => {
  it("writes policy/work-autonomy.cedar from the spec's work.toml", () => {
    const generated = generateAutonomyPolicy(fixtureWork());
    expect(generated.errors).toEqual([]);
    expect(generated.path).toBe(AUTONOMY_POLICY_PATH);
    expect(AUTONOMY_POLICY_PATH).toBe("policy/work-autonomy.cedar");
    expect(Object.keys(generated.policies)).toEqual([
      HIGH_RISK_FORBID_ID,
      RISK_UNKNOWN_FORBID_ID,
      "work.send/label:Documentation",
      "work.merge/label:Documentation",
      "work.lock/label:Documentation",
      "work.close/label:Documentation",
      'work.send/repo:aintel/billing-service:["src/**"]',
      'work.merge/repo:aintel/billing-service:["src/**"]',
      'work.lock/repo:aintel/billing-service:["src/**"]',
      'work.close/repo:aintel/billing-service:["src/**"]',
    ]);
    const text = generated.text ?? "";
    expect(text.startsWith("// Written by Oxagen from the [[autonomy]] entries of work/work.toml.")).toBe(true);
    expect(text.endsWith("};\n")).toBe(true);
    expect(text).toContain('// Scope "label:Documentation". work.toml sets level 2. Operator "priya".');
    expect(text).toContain(
      '// Scope "repo:aintel/billing-service:[\\"src/**\\"]". work.toml sets level 1. Operator "sam".',
    );
    expect(text).toContain("resource.spent_today_cents < 4000");
    expect(text).toContain("resource.spent_today_cents < 12000");
    for (const policy of Object.values(generated.policies)) expect(text).toContain(policy);
  });

  it("writes a file Cedar reads as exactly the policies it lists", () => {
    const generated = generateAutonomyPolicy(fixtureWork());
    expect(policyCount(generated.text ?? "")).toBe(Object.keys(generated.policies).length);
  });

  it("writes policies that validate in strict mode, as text and by id", () => {
    const generated = generateAutonomyPolicy(fixtureWork());
    expect(validate(generated.text ?? "")).toMatchObject({ type: "success", validationErrors: [] });
    expect(validate(generated.policies)).toMatchObject({ type: "success", validationErrors: [] });
  });

  it("validates beside the tool-call schema that policy/schema.cedarschema holds", () => {
    const generated = generateAutonomyPolicy(fixtureWork());
    const joined = `${writeCedarSchema({})}\n${AUTONOMY_CEDAR_SCHEMA}`;
    expect(validate(generated.policies, joined)).toMatchObject({ type: "success", validationErrors: [] });
  });

  it("names the scope's operator as the principal of every permit", () => {
    const generated = generateAutonomyPolicy(fixtureWork());
    const permits = Object.entries(generated.policies).filter(([id]) => !(id in AUTONOMY_FORBIDS));
    expect(permits).toHaveLength(8);
    for (const [id, text] of permits) {
      const operator = id.includes("label:Documentation") ? "priya" : "sam";
      expect(text).toContain(`principal == Oxagen::Operator::"${operator}",`);
    }
  });

  it("writes the shared forbids alone when work.toml sets no scope", () => {
    const generated = generateAutonomyPolicy({});
    expect(generated.errors).toEqual([]);
    expect(generated.policies).toEqual({ ...AUTONOMY_FORBIDS });
    expect(policyCount(generated.text ?? "")).toBe(2);
    expect(validate(generated.text ?? "")).toMatchObject({ type: "success", validationErrors: [] });
  });

  it("refuses a level outside 0 to 3", () => {
    const generated = generateAutonomyPolicy({ autonomy: [entry({ level: 4 as never })] });
    expect(generated).toEqual({
      path: AUTONOMY_POLICY_PATH,
      text: null,
      policies: {},
      errors: ['[[autonomy]] entry 1 ("label:Documentation"): level must be 0, 1, 2, or 3.'],
    });
  });

  it("refuses a scope that is neither a label nor a repository", () => {
    const generated = generateAutonomyPolicy({ autonomy: [entry({ scope: { label: "" } })] });
    expect(generated.text).toBeNull();
    expect(generated.errors).toEqual([
      "[[autonomy]] entry 1: The scope must be { label } or { repo, paths } with at least one path, and no value may be empty.",
    ]);
  });

  it("refuses a scope with no operator", () => {
    const generated = generateAutonomyPolicy({ autonomy: [entry({ operator: "  " })] });
    expect(generated.text).toBeNull();
    expect(generated.errors).toEqual([
      '[[autonomy]] entry 1 ("label:Documentation"): Every scope needs an operator. Oxagen acts as that person at every level.',
    ]);
  });

  it.each([
    ["zero", 0],
    ["a negative amount", -5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["less than a cent", 0.001],
    ["more cents than Cedar's Long holds", 1e300],
    ["a string", "40"],
  ])("refuses max_daily_usd of %s", (_name, max) => {
    const generated = generateAutonomyPolicy({ autonomy: [entry({ max_daily_usd: max as number })] });
    expect(generated.text).toBeNull();
    expect(generated.errors).toEqual([
      '[[autonomy]] entry 1 ("label:Documentation"): max_daily_usd must be a number of dollars above 0.',
    ]);
  });

  it("refuses two entries for one scope, comparing repositories without case", () => {
    const generated = generateAutonomyPolicy({
      autonomy: [
        entry({ scope: { repo: "Aintel/Web" } }),
        entry({ scope: { label: "Documentation" } }),
        entry({ scope: { repo: "aintel/web" }, operator: "sam" }),
      ],
    });
    expect(generated.text).toBeNull();
    expect(generated.errors).toEqual([
      '[[autonomy]] entry 3 ("repo:aintel/web"): entry 1 already sets this scope. Give each scope one entry.',
    ]);
  });

  it("reports every entry's errors together", () => {
    const generated = generateAutonomyPolicy({
      autonomy: [entry({ level: 9 as never, operator: "" }), entry({ scope: { repo: "" } })],
    });
    expect(generated.errors).toHaveLength(3);
  });

  it("keeps a label with a newline from starting a policy in a comment", () => {
    const label = 'Docs\n}; permit (principal, action, resource);\n// "';
    const generated = generateAutonomyPolicy({ autonomy: [entry({ scope: { label }, operator: "pri\nya" })] });
    expect(generated.errors).toEqual([]);
    const text = generated.text ?? "";
    expect(policyCount(text)).toBe(6);
    expect(validate(text)).toMatchObject({ type: "success", validationErrors: [] });
    const comments = text.split("\n").filter((line) => line.startsWith("// Scope"));
    expect(comments).toEqual([
      '// Scope "label:Docs\\n}; permit (principal, action, resource);\\n// \\"". work.toml sets level 2. Operator "pri\\nya".',
    ]);
  });
});

describe("policiesForScope", () => {
  it("writes the four permits in file order", () => {
    const scoped = policiesForScope({ label: "Documentation" }, "priya", 40);
    expect(scoped.errors).toEqual([]);
    expect(Object.keys(scoped.policies)).toEqual([
      "work.send/label:Documentation",
      "work.merge/label:Documentation",
      "work.lock/label:Documentation",
      "work.close/label:Documentation",
    ]);
  });

  it("writes each action's conditions after the scope and level tests", () => {
    const { policies } = policiesForScope({ label: "Documentation" }, "priya", 40);
    expect(policies["work.send/label:Documentation"]).toBe(`@id("work.send/label:Documentation")
permit (
  principal == Oxagen::Operator::"priya",
  action == Oxagen::Action::"work.send",
  resource is Oxagen::WorkOrder
)
when {
  resource.scope == "label:Documentation" &&
  resource.level >= 1 &&
  resource.spent_today_cents < 4000
};`);
    expect(policies["work.merge/label:Documentation"]).toContain(
      'resource.level >= 2 &&\n  resource.verdict == "proven" &&\n  resource has risk &&\n  resource.risk != "high"\n};',
    );
    expect(policies["work.lock/label:Documentation"]).toContain("resource.level >= 3 &&\n  resource.lint_passed\n};");
    expect(policies["work.close/label:Documentation"]).toContain("resource.level >= 3 &&\n  resource.close_switch\n};");
  });

  it("leaves the budget out of work.send when the scope sets none", () => {
    const { policies } = policiesForScope({ label: "Documentation" }, "priya");
    expect(policies["work.send/label:Documentation"]).toContain("resource.level >= 1\n};");
  });

  it("rounds a budget to whole cents", () => {
    const { policies } = policiesForScope({ label: "Documentation" }, "priya", 12.349);
    expect(policies["work.send/label:Documentation"]).toContain("resource.spent_today_cents < 1235");
  });

  it("refuses an operator that is not a string, and a scope that does not parse", () => {
    expect(policiesForScope({ label: "Documentation" }, 42).errors).toEqual([
      "Every scope needs an operator. Oxagen acts as that person at every level.",
    ]);
    expect(policiesForScope({ repo: "aintel/web", paths: [] }, "priya")).toEqual({
      policies: {},
      errors: [
        "The scope must be { label } or { repo, paths } with at least one path, and no value may be empty.",
      ],
    });
  });
});

describe("permitId", () => {
  it("names the action and the scope", () => {
    expect(permitId("work.merge", { repo: "Aintel/Web", paths: ["src/**"] })).toBe(
      'work.merge/repo:aintel/web:["src/**"]',
    );
  });
});

describe("commentSafe", () => {
  it("quotes the text and escapes every character outside printable ASCII", () => {
    expect(commentSafe("Docs")).toBe('"Docs"');
    expect(commentSafe("a\nb c")).toBe('"a\\nb\\u{2028}c"');
    expect(commentSafe("Café ✓")).toBe('"Caf\\u{e9} \\u{2713}"');
    expect(commentSafe("😀")).toBe('"\\u{1f600}"');
  });
});
