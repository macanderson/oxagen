// schema.test.ts: the spec's done record validates against done-record/v1, and
// the schema agrees with the constants in types.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnySchemaObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DONE_RECORD_SCHEMA_URL,
  SCHEMA_BASE_URL,
  doneRecordSchemaPath,
  schemaFileName,
  schemasDir,
} from "./schema";
import {
  BUDGET_DEFAULT_STOP_ATTEMPTS,
  CHECK_KINDS,
  CRITERION_STATES,
  CRITERION_TAGS,
  DONE_CHECK_NAME,
  DONE_REASONS,
  DONE_REASON_CODES,
  DONE_RECORD_PREDICATE_TYPE,
  DONE_VERDICTS,
  MAX_CRITERIA,
  ORACLE_CLASSES,
  RUN_CHECK_DEFAULT_TIMEOUT_S,
  type DoneRecord,
} from "./types";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The parts of the schema file these tests read. */
type SchemaDoc = {
  $id: string;
  $schema: string;
  properties: { criteria: { maxItems: number } };
  $defs: {
    check: { oneOf: { $ref: string }[] };
    criterion: { properties: { tag: { enum: string[] } } };
    oracle: { properties: { class: { enum: string[] } } };
    runCheck: { properties: { timeout_s: { default: number } } };
    budgetCheck: { properties: { budget: { properties: { stop_attempts: { default: number } } } } };
  };
};

const raw = readFileSync(doneRecordSchemaPath(), "utf8");
const doc = JSON.parse(raw) as SchemaDoc;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(raw) as AnySchemaObject);

function valid(value: unknown): boolean {
  return validate(value);
}

function fixture(): Record<string, unknown> {
  return parseYaml(readFileSync(join(FIXTURES, "done-record.yaml"), "utf8")) as Record<string, unknown>;
}

/** The spec's example, typed. It must compile as a DoneRecord and validate. */
const example: DoneRecord = {
  schema: "done-record/v1",
  item: "wi_01K5ZQ4M8T2DXW",
  lineage: "aintel.platform.invoice-export-timeout",
  drafted_by: { model: "triage-second", decision: "tri_01K5ZQ5A1C9E" },
  criteria: [
    {
      id: "c1",
      text: "Invoice export finishes for an account with 10,000 invoices.",
      tag: "code",
      check: { run: "pnpm --filter @aintel/billing test -- export.large" },
      oracle: { class: "executable", witness: "tests/billing/export.large.test.ts" },
      negative: "An account with 10,001 invoices exports in two pages.",
    },
    {
      id: "c2",
      text: "The change touches only billing code and its tests.",
      tag: "code",
      check: { diff: { allow: ["src/billing/**", "tests/billing/**"], deny: ["migrations/**"] } },
      oracle: { class: "structural" },
      negative: "A change to src/auth/session.ts fails.",
    },
    {
      id: "c3",
      text: "The export writes one row per invoice, voided invoices included.",
      tag: "test",
      oracle: { class: "predicate", witness: "witness/export-rows.json" },
      negative: "An account with one voided invoice gets 3 rows for 3 invoices.",
    },
    {
      id: "c4",
      text: "The billing owner signs off on the page size.",
      tag: "review",
      check: { human: "sam" },
    },
  ],
  lock: {
    digest: "sha256:0e5a9c2d7b41f83e6a0c9d1b5f27e4a8c3d60b9f1e2a7c54d8b0f3e6a19c2d7b",
    by: "priya",
    at: "2026-09-26T18:04:11Z",
  },
};

function withCriterion(criterion: Record<string, unknown>): Record<string, unknown> {
  return { ...example, criteria: [criterion] };
}

describe("done-record/v1", () => {
  it("publishes the schema at its id", () => {
    expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(doc.$id).toBe(DONE_RECORD_SCHEMA_URL);
    expect(DONE_RECORD_SCHEMA_URL).toBe("https://oxagen.sh/schemas/done-record/v1.json");
    expect(SCHEMA_BASE_URL).toBe("https://oxagen.sh/schemas/");
    expect(schemaFileName("done-record/v1")).toBe("done-record.v1.json");
    expect(doneRecordSchemaPath()).toBe(join(schemasDir(), "done-record.v1.json"));
  });

  it("validates the spec's example file", () => {
    const record = fixture();
    expect(valid(record), ajv.errorsText(validate.errors)).toBe(true);
    expect(record).toEqual(example);
  });

  it("validates the typed example", () => {
    expect(valid(example), ajv.errorsText(validate.errors)).toBe(true);
  });

  it("accepts a record a person wrote, with no drafter and no lock", () => {
    const { drafted_by: _drafter, lock: _lock, ...record } = example;
    expect(valid(record)).toBe(true);
  });

  it("accepts every check kind", () => {
    const checks = [
      { run: "pnpm test", timeout_s: 30 },
      { file: { path: "README.md", exists: true, contains: "Oxagen", sha256: `sha256:${"a".repeat(64)}` } },
      { diff: {} },
      { tools: { deny: ["Bash"] } },
      { budget: { usd: 4.5, tool_calls: 200, minutes: 30, stop_attempts: 3 } },
      { human: "sam" },
    ];
    expect(checks).toHaveLength(CHECK_KINDS.length);
    for (const check of checks) {
      expect(valid(withCriterion({ id: "c1", text: "t", tag: "code", check })), JSON.stringify(check)).toBe(true);
    }
  });

  it("rejects a seventh check kind and a check with two kinds", () => {
    expect(valid(withCriterion({ id: "c1", text: "t", tag: "code", check: { lint: "eslint" } }))).toBe(false);
    expect(valid(withCriterion({ id: "c1", text: "t", tag: "code", check: { run: "a", human: "sam" } }))).toBe(false);
  });

  it("rejects an oracle class the registry does not know", () => {
    expect(valid(withCriterion({ id: "c1", text: "t", tag: "code", oracle: { class: "judgment" } }))).toBe(false);
  });

  it("rejects malformed records", () => {
    expect(valid({ ...example, criteria: [] })).toBe(false);
    const many = Array.from({ length: MAX_CRITERIA + 1 }, (_, i) => ({ id: `c${i}`, text: "t", tag: "code" }));
    expect(valid({ ...example, criteria: many })).toBe(false);
    expect(valid({ ...example, item: "01K5ZQ4M8T2DXW" })).toBe(false);
    expect(valid({ ...example, drafted_by: { model: "triage-second" } })).toBe(false);
    expect(valid({ ...example, lock: { ...example.lock, digest: "sha256:abc" } })).toBe(false);
    expect(valid({ ...example, lock: { ...example.lock, at: "yesterday" } })).toBe(false);
    expect(valid(withCriterion({ id: "C1", text: "t", tag: "code" }))).toBe(false);
    expect(valid(withCriterion({ id: "c1", text: "t", tag: "ops" }))).toBe(false);
    expect(valid({ ...example, extra: true })).toBe(false);
  });

  it("agrees with the constants", () => {
    expect(doc.properties.criteria.maxItems).toBe(MAX_CRITERIA);
    expect(doc.$defs.check.oneOf).toHaveLength(CHECK_KINDS.length);
    expect(doc.$defs.check.oneOf.map((ref) => ref.$ref)).toEqual(
      CHECK_KINDS.map((kind) => `#/$defs/${kind}Check`),
    );
    expect(doc.$defs.criterion.properties.tag.enum).toEqual([...CRITERION_TAGS]);
    expect(doc.$defs.oracle.properties.class.enum).toEqual([...ORACLE_CLASSES]);
    expect(ORACLE_CLASSES).toHaveLength(14);
    expect(doc.$defs.runCheck.properties.timeout_s.default).toBe(RUN_CHECK_DEFAULT_TIMEOUT_S);
    expect(doc.$defs.budgetCheck.properties.budget.properties.stop_attempts.default).toBe(
      BUDGET_DEFAULT_STOP_ATTEMPTS,
    );
  });
});

describe("shared names", () => {
  it("fixes the attestation predicate type and the check name", () => {
    expect(DONE_RECORD_PREDICATE_TYPE).toBe("https://oxagen.sh/attestations/done-record/v1");
    expect(DONE_CHECK_NAME).toBe("Oxagen done");
  });

  it("fixes the states, verdicts, and reason codes", () => {
    expect(CRITERION_STATES).toEqual(["open", "claimed", "held", "proven", "failed"]);
    expect(DONE_VERDICTS).toEqual(["pending", "held", "proven", "broken"]);
    expect(DONE_REASON_CODES).toEqual([
      "CHECK_FAILED",
      "TOOL_DENIED",
      "BUDGET_EXCEEDED",
      "ATTEMPTS_EXHAUSTED",
      "LOCK_MISMATCH",
      "EVIDENCE_INVALID",
      "HUMAN_PENDING",
      "HARNESS_ERROR",
    ]);
    for (const code of DONE_REASON_CODES) expect(DONE_REASONS[code].length).toBeGreaterThan(0);
  });
});
