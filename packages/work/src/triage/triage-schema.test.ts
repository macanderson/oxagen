// triage-schema.test.ts: checkTriageSchema and Ajv agree on every document
// here, valid or not, so the hand-written check keeps the schema file's rules.
import { readFileSync } from "node:fs";
import type { AnySchemaObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { workSchemaPath } from "../schemas";
import { TRIAGE_SCHEMA } from "../types";
import { recordedOutput } from "./fixtures/triage-fixtures";
import { TRIAGE_V1_SCHEMA, checkTriageSchema } from "./triage-schema";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(TRIAGE_V1_SCHEMA as AnySchemaObject);

type Doc = Record<string, unknown>;

/** The recorded output with one change. */
function variant(change: (doc: Doc) => void): Doc {
  const doc = recordedOutput();
  change(doc);
  return doc;
}

function priority(doc: Doc): Doc {
  return doc.priority as Doc;
}

const notTriaged = (state: string) => (doc: Doc) => {
  doc.state = state;
  doc.workflow = null;
  doc.done_record = null;
};

const valid: [string, unknown][] = [
  ["the recorded output", recordedOutput()],
  [
    "a needs_info decision with a question",
    variant((doc) => {
      notTriaged("needs_info")(doc);
      doc.questions = ["Which invoice format does the customer export?"];
    }),
  ],
  [
    "a duplicate decision that names the duplicate",
    variant((doc) => {
      notTriaged("duplicate")(doc);
      doc.duplicates = ["wi_01K5YV0B3N7PRA"];
      doc.related = [];
    }),
  ],
  ["an out_of_scope decision with no done record", variant(notTriaged("out_of_scope"))],
  ["a needs_info decision that keeps its drafted done record", variant((doc) => { doc.state = "needs_info"; doc.questions = ["Split how?"]; })],
  ["a decision with no cites", variant((doc) => { priority(doc).cites = []; })],
  ["an estimate of zero minutes", variant((doc) => { doc.estimate_minutes = 0; })],
  ["a workflow slug of 64 characters", variant((doc) => { doc.workflow = "a".repeat(64); })],
  ["a triaged decision with no workflow, as Phase 1 writes", variant((doc) => { doc.workflow = null; })],
];

const invalid: [string, unknown][] = [
  ["null", null],
  ["an array", [recordedOutput()]],
  ["a string", "triage/v1"],
  ["a missing field", variant((doc) => { delete doc.conflicts; })],
  ["an extra field", variant((doc) => { doc.confidence = 0.9; })],
  ["another schema", variant((doc) => { doc.schema = "triage/v2"; })],
  ["an item that is not a work item id", variant((doc) => { doc.item = "WI_01K5ZQ4M8T2DXW"; })],
  ["an item that is not a string", variant((doc) => { doc.item = 42; })],
  ["an unknown state", variant((doc) => { doc.state = "done"; })],
  ["a priority that is null", variant((doc) => { doc.priority = null; })],
  ["a priority that is an array", variant((doc) => { doc.priority = ["P1"]; })],
  ["a priority with no reason", variant((doc) => { delete priority(doc).reason; })],
  ["a priority with an extra field", variant((doc) => { priority(doc).score = 3; })],
  ["the label P4", variant((doc) => { priority(doc).label = "P4"; })],
  ["an empty reason", variant((doc) => { priority(doc).reason = ""; })],
  ["a reason that is not a string", variant((doc) => { priority(doc).reason = 5; })],
  ["cites that are not an array", variant((doc) => { priority(doc).cites = "aintel.work.priorities#2"; })],
  ["a cite with no rule number", variant((doc) => { priority(doc).cites = ["aintel.work.priorities"]; })],
  ["a cite that is not a string", variant((doc) => { priority(doc).cites = [2]; })],
  ["a repeated cite", variant((doc) => { priority(doc).cites = ["aintel.work.priorities#2", "aintel.work.priorities#2"]; })],
  ["labels that are not an array", variant((doc) => { doc.labels = "Bug"; })],
  ["an empty label", variant((doc) => { doc.labels = [""]; })],
  ["a label that is not a string", variant((doc) => { doc.labels = [1]; })],
  ["a repeated label", variant((doc) => { doc.labels = ["Bug", "Bug"]; })],
  ["a fractional estimate", variant((doc) => { doc.estimate_minutes = 1.5; })],
  ["a negative estimate", variant((doc) => { doc.estimate_minutes = -1; })],
  ["an estimate that is a string", variant((doc) => { doc.estimate_minutes = "45"; })],
  ["a repeated claim", variant((doc) => { doc.claims = ["src/**", "src/**"]; })],
  ["a duplicate that is not a work item id", variant((doc) => { doc.duplicates = ["481"]; })],
  ["a related id with no suffix", variant((doc) => { doc.related = ["wi_"]; })],
  ["a repeated related id", variant((doc) => { doc.related = ["wi_01K5YV0B3N7PRA", "wi_01K5YV0B3N7PRA"]; })],
  ["a workflow with spaces", variant((doc) => { doc.workflow = "Fix test"; })],
  ["a workflow slug of 65 characters", variant((doc) => { doc.workflow = "a".repeat(65); })],
  ["a workflow that is a number", variant((doc) => { doc.workflow = 5; })],
  ["a done record that is an array", variant((doc) => { doc.done_record = ["A test passes."]; })],
  ["a done record with no criteria", variant((doc) => { doc.done_record = { criteria: [] }; })],
  ["a done record with an empty criterion", variant((doc) => { doc.done_record = { criteria: [""] }; })],
  ["a done record with an extra field", variant((doc) => { doc.done_record = { criteria: ["A test passes."], owner: "priya" }; })],
  ["a done record missing criteria", variant((doc) => { doc.done_record = {}; })],
  ["an empty question", variant((doc) => { doc.questions = [""]; })],
  ["conflicts that are a string", variant((doc) => { doc.conflicts = "none"; })],
  ["a triaged decision with no done record", variant((doc) => { doc.done_record = null; })],
  ["a needs_info decision with no question", variant((doc) => { notTriaged("needs_info")(doc); })],
  ["a duplicate decision that names no duplicate", variant((doc) => { notTriaged("duplicate")(doc); })],
  ["an out_of_scope decision with a done record", variant((doc) => { doc.state = "out_of_scope"; })],
];

describe("TRIAGE_V1_SCHEMA", () => {
  it("is the schema file on disk", () => {
    const onDisk: unknown = JSON.parse(readFileSync(workSchemaPath(TRIAGE_SCHEMA), "utf8"));
    expect(TRIAGE_V1_SCHEMA).toEqual(onDisk);
  });
});

describe("checkTriageSchema", () => {
  it.each(valid)("accepts %s, as Ajv does", (_name, doc) => {
    expect(validate(doc)).toBe(true);
    const checked = checkTriageSchema(doc);
    expect(checked).toEqual({ ok: true, decision: doc });
  });

  it.each(invalid)("rejects %s, as Ajv does", (_name, doc) => {
    expect(validate(doc)).toBe(false);
    const checked = checkTriageSchema(doc);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problems.length).toBeGreaterThan(0);
  });

  it("names each problem by its JSON pointer", () => {
    expect(checkTriageSchema(null)).toEqual({ ok: false, problems: ["/ is not an object"] });
    const doc = variant((d) => {
      priority(d).label = "P4";
      d.labels = [""];
      priority(d).cites = ["aintel.work.priorities"];
      d.done_record = { criteria: [] };
    });
    expect(checkTriageSchema(doc)).toEqual({
      ok: false,
      problems: [
        "/priority/label is not P0, P1, P2, or P3",
        "/priority/cites/0 does not match ^[a-z0-9][a-z0-9.-]*[a-z0-9]#[0-9]+$",
        "/labels/0 is empty",
        "/done_record/criteria needs at least 1 item",
      ],
    });
  });
});
