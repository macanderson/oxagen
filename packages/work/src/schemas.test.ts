// schemas.test.ts: every example in agent-work-spec.html validates against its
// schema, a typed copy of each compiles against types.ts, and the schemas agree
// with the constants the other lanes import.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CRITERION_TAGS, SCHEMA_BASE_URL, schemaFileName } from "@oxagen/done-record";
import type { AnySchemaObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { WORK_SCHEMA_IDS, type WorkSchemaId, schemaUrl, workSchemaPath, workSchemasDir } from "./schemas";
import {
  ACCEPT_BY,
  AUTONOMY_LEVELS,
  COLLECTOR_SCHEMA,
  COLLECTOR_TYPES,
  COLLECTOR_TYPES_WITHOUT_WRITE_BACK,
  type CollectorFile,
  type CollectorScopes,
  DEFAULT_SAMPLE_RATE,
  MAX_RETURNS,
  ON_FAIL,
  PRIORITY_LABELS,
  SLACK_TRIGGERS,
  STAGE_KINDS,
  TRAINING_CONSENTS,
  TRAINING_EXAMPLE_SCHEMA,
  TRAINING_LABELS,
  TRIAGE_SCHEMA,
  TRIAGE_STATES,
  type TrainingConsent,
  type TrainingExample,
  type TriageDecision,
  WORK_FILE_SCHEMA,
  WORKFLOW_SCHEMA,
  WORKFLOW_SCHEMAS,
  WRITE_BACK_DEFAULTS,
  type WorkFile,
  type Workflow,
} from "./types";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

function readSchema(id: WorkSchemaId): AnySchemaObject {
  return JSON.parse(readFileSync(workSchemaPath(id), "utf8")) as AnySchemaObject;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

const docs = {
  collector: readSchema(COLLECTOR_SCHEMA),
  work: readSchema(WORK_FILE_SCHEMA),
  workflow: readSchema(WORKFLOW_SCHEMA),
  triage: readSchema(TRIAGE_SCHEMA),
  training: readSchema(TRAINING_EXAMPLE_SCHEMA),
};

const validators = {
  collector: ajv.compile(docs.collector),
  work: ajv.compile(docs.work),
  workflow: ajv.compile(docs.workflow),
  triage: ajv.compile(docs.triage),
  training: ajv.compile(docs.training),
};

/** Validate, and name the errors in the failure message. */
function expectValid(validate: ValidateFunction, value: unknown): void {
  const ok = validate(value);
  expect(ok, ajv.errorsText(validate.errors)).toBe(true);
}

function expectInvalid(validate: ValidateFunction, value: unknown): void {
  expect(validate(value), JSON.stringify(value)).toBe(false);
}

function toml(path: string): Record<string, unknown> {
  return parseToml(readFileSync(join(FIXTURES, path), "utf8")) as Record<string, unknown>;
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, path), "utf8"));
}

/** Read a value at a path inside a parsed schema. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

// ---------------------------------------------------------------------------
// The spec's examples, typed. Each must compile against types.ts and match the
// fixture file it was copied from.
// ---------------------------------------------------------------------------

const zendesk: CollectorFile = {
  schema: "collector/v1",
  name: "support-zendesk",
  label: "Support escalations",
  type: "zendesk",
  connection: "conn_01K5ZD7Q4R",
  scope: { subdomain: "aintel", views: ["Engineering escalations"] },
  defaults: { labels: ["Bug"], workflow: "fix-test-verify-review" },
  write_back: { certify_note: true, send_note: true, status: false, close: false, labels: false },
};

const slack: CollectorFile = {
  schema: "collector/v1",
  name: "eng-requests",
  label: "#eng-requests",
  type: "slack",
  connection: "conn_01K5ZS2V8W",
  scope: { channel: "C07ENGREQ", trigger: "reaction", allow_bots: ["B05PAGERDUTY"] },
};

const email: CollectorFile = {
  schema: "collector/v1",
  name: "inbox",
  label: "Engineering inbox",
  type: "email",
  scope: { allow: ["@aintel.com", "ops@northwind.example"], forwarders: ["support@aintel.com"] },
};

const work: WorkFile = {
  schema: "work/v1",
  triage: {
    operator: "priya",
    priorities: "aintel.work.priorities",
    models: ["triage-primary", "triage-second"],
  },
  autonomy: [
    { scope: { label: "Documentation" }, level: 2, operator: "priya", max_daily_usd: 40 },
    {
      scope: { repo: "aintel/billing-service", paths: ["src/**"] },
      level: 1,
      operator: "sam",
      max_daily_usd: 120,
    },
  ],
};

const workflow: Workflow = {
  schema: "oxagen-workflow/v0.3",
  name: "Fix, test, verify, review",
  owner: "priya",
  match: { labels: ["Bug"], collectors: ["support-zendesk", "github-core"] },
  done: {
    criteria: ["A test fails before the change and passes after it.", "CI passes on the pull request."],
  },
  stage: [
    { role: "Fix", kind: "build", agent: "aintel.core.bug-fixer", owns: ["code"], on_fail: "stop" },
    {
      role: "Test",
      kind: "test",
      agent: "aintel.core.test-writer",
      needs: ["Fix"],
      owns: ["test"],
      on_fail: "return",
      return_to: "Fix",
      max_returns: 2,
    },
    { role: "Verify", kind: "verify", agent: "aintel.core.verifier", needs: ["Test"], model: "verify-route" },
    {
      role: "Review",
      kind: "review",
      agent: "aintel.core.architect",
      needs: ["Verify"],
      owns: ["review"],
      on_fail: "return",
      return_to: "Fix",
      max_returns: 1,
    },
  ],
  accept: { by: "operator" },
};

const triage: TriageDecision = {
  schema: "triage/v1",
  item: "wi_01K5ZQ4M8T2DXW",
  state: "triaged",
  priority: {
    label: "P1",
    reason: "A paying customer reported it, and it blocks their invoice export.",
    cites: ["aintel.work.priorities#2"],
  },
  labels: ["Bug"],
  estimate_minutes: 45,
  claims: ["apps/app/src/features/billing/**"],
  duplicates: [],
  related: ["wi_01K5YV0B3N7PRA"],
  workflow: "fix-test-verify-review",
  done_record: { criteria: ["…"] },
  questions: [],
  conflicts: [],
};

const example: TrainingExample = {
  schema: "training-example/v1",
  item: "wi_01K5ZQ4M8T2DXW",
  record: "sha256:0e5a9c2d7b41f83e6a0c9d1b5f27e4a8c3d60b9f1e2a7c54d8b0f3e6a19c2d7b",
  label: "positive",
  stage: "build",
  messages: [
    { role: "system", content: "…steering records the session received…" },
    { role: "user", content: "…the work order brief and the done record…" },
    { role: "assistant", content: "…", tool_calls: [{ "…": "…" }] },
    { role: "tool", tool_call_id: "…", content: "…" },
  ],
  tools: [{ "…": "…" }],
  diff: "…",
  corrections: [{ field: "priority", before: "P2", after: "P1" }],
};

const training: { training: TrainingConsent } = {
  training: { consent: "own_model", approved_by: "mac", base: "open-weight/code-32b" },
};

// ---------------------------------------------------------------------------

describe("schema files", () => {
  it("publishes each schema at its id", () => {
    expect(SCHEMA_BASE_URL).toBe("https://oxagen.sh/schemas/");
    expect(schemaUrl("triage/v1")).toBe("https://oxagen.sh/schemas/triage/v1.json");
    expect(schemaUrl("oxagen-workflow/v0.3")).toBe("https://oxagen.sh/schemas/oxagen-workflow/v0.3.json");
    for (const id of WORK_SCHEMA_IDS) {
      const doc = readSchema(id);
      expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(doc.$id).toBe(schemaUrl(id));
      expect(workSchemaPath(id)).toBe(join(workSchemasDir(), schemaFileName(id)));
    }
  });

  it("holds exactly the five schema files", () => {
    expect(readdirSync(workSchemasDir()).sort()).toEqual(WORK_SCHEMA_IDS.map(schemaFileName).sort());
  });
});

describe("collector/v1", () => {
  const validate = validators.collector;

  it("validates the spec's Zendesk, Slack, and email collectors", () => {
    const cases: [string, CollectorFile][] = [
      ["collectors/support-zendesk.toml", zendesk],
      ["collectors/eng-requests.toml", slack],
      ["collectors/inbox.toml", email],
    ];
    for (const [path, typed] of cases) {
      const file = toml(path);
      expectValid(validate, file);
      expect(file).toEqual(typed);
      expectValid(validate, typed);
    }
  });

  it("accepts a minimal file of every type", () => {
    const scopes: CollectorScopes = {
      github: { repos: ["aintel/core"] },
      jira: { site: "aintel.atlassian.net", projects: ["CORE"], jql: "priority = High" },
      linear: { teams: ["ENG"] },
      zendesk: { subdomain: "aintel", groups: ["Tier 2"] },
      servicenow: { instance: "aintel", table: "incident", query: "active=true" },
      salesforce: { my_domain: "aintel", queues: ["Escalations"] },
      slack: { channel: "C07ENGREQ", trigger: "every_message" },
      email: { allow: ["@aintel.com"] },
    };
    for (const type of COLLECTOR_TYPES) {
      const connection = type === "email" ? {} : { connection: "conn_01K5ZD7Q4R" };
      expectValid(validate, { schema: COLLECTOR_SCHEMA, name: `${type}-in`, label: type, type, scope: scopes[type], ...connection });
    }
  });

  it("keeps a connection off email and write-back off Slack and email", () => {
    expectInvalid(validate, { ...email, connection: "conn_01K5ZD7Q4R" });
    expectInvalid(validate, { ...email, write_back: { certify_note: false } });
    expectInvalid(validate, { ...slack, write_back: { close: true } });
    const { connection: _connection, ...noConnection } = zendesk as Record<string, unknown>;
    expectInvalid(validate, noConnection);
  });

  it("checks the scope against the type", () => {
    expectInvalid(validate, { ...zendesk, scope: { subdomain: "aintel" } });
    expectValid(validate, { ...zendesk, scope: { subdomain: "aintel", groups: ["Tier 2"] } });
    expectInvalid(validate, { ...zendesk, type: "salesforce", scope: { my_domain: "aintel" } });
    expectInvalid(validate, { ...zendesk, type: "github", scope: { subdomain: "aintel", views: ["v"] } });
    expectInvalid(validate, { ...zendesk, type: "github", scope: { repos: ["not a repo"] } });
    expectInvalid(validate, { ...slack, scope: { channel: "general" } });
    expectInvalid(validate, { ...slack, scope: { channel: "C07ENGREQ", allow_bots: ["U123"] } });
    expectInvalid(validate, { ...email, scope: { allow: ["nobody"] } });
    expectInvalid(validate, { ...email, scope: { allow: [] } });
  });

  it("rejects malformed files", () => {
    expectInvalid(validate, { ...zendesk, type: "trello" });
    expectInvalid(validate, { ...zendesk, name: "Support Zendesk" });
    expectInvalid(validate, { ...zendesk, schema: "collector/v2" });
    expectInvalid(validate, { ...zendesk, write_back: { reopen: true } });
    expectInvalid(validate, { ...zendesk, defaults: { workflow: "Fix it" } });
    expectInvalid(validate, { ...zendesk, token: "secret" });
  });
});

describe("work/v1", () => {
  const validate = validators.work;

  it("validates the spec's work.toml", () => {
    const file = toml("work.toml");
    expectValid(validate, file);
    expect(file).toEqual(work);
    expectValid(validate, work);
  });

  it("accepts a file with no autonomy and a level 3 scope with a sample rate", () => {
    const { autonomy: _autonomy, ...bare } = work;
    expectValid(validate, bare);
    expectValid(validate, {
      ...work,
      autonomy: [{ scope: { repo: "aintel/docs" }, level: 3, operator: "priya", sample_rate: 1 }],
    });
  });

  it("rejects malformed files", () => {
    const entry = { scope: { label: "Documentation" }, level: 2, operator: "priya" };
    expectInvalid(validate, { ...work, autonomy: [{ ...entry, level: 4 }] });
    expectInvalid(validate, { ...work, autonomy: [{ ...entry, level: 1.5 }] });
    expectInvalid(validate, { ...work, autonomy: [{ ...entry, sample_rate: 0 }] });
    expectInvalid(validate, { ...work, autonomy: [{ ...entry, sample_rate: 1.5 }] });
    expectInvalid(validate, { ...work, autonomy: [{ ...entry, max_daily_usd: 0 }] });
    expectInvalid(validate, { ...work, autonomy: [{ ...entry, scope: { label: "Docs", repo: "aintel/docs" } }] });
    expectInvalid(validate, { ...work, autonomy: [{ level: 2, operator: "priya" }] });
    expectInvalid(validate, { ...work, triage: { ...work.triage, models: ["triage-primary"] } });
    expectInvalid(validate, { ...work, triage: { ...work.triage, priorities: "Priorities" } });
    expectInvalid(validate, { schema: "work/v1" });
    expectInvalid(validate, { ...work, training: { consent: "own_model" } });
  });
});

describe("oxagen-workflow/v0.3", () => {
  const validate = validators.workflow;

  it("validates the spec's v0.3 workflow", () => {
    const file = toml("workflows/fix-test-verify-review.toml");
    expectValid(validate, file);
    expect(file).toEqual(workflow);
    expectValid(validate, workflow);
  });

  it("reads the v0.1 and v0.2 workflows unchanged", () => {
    const v01 = toml("workflows/fix-validate-document-review.v0.1.toml");
    const v02 = toml("workflows/fix-validate-document-review.v0.2.toml");
    expectValid(validate, v01);
    expectValid(validate, v02);
    expect(at(v01, "stage", 1, "return_to")).toBe(1);
    expect(at(v02, "stage", 1, "return_to")).toBe("Fix");
  });

  it("keeps the v0.3 keys out of v0.1 and v0.2 files", () => {
    const v01 = toml("workflows/fix-validate-document-review.v0.1.toml");
    const v02 = toml("workflows/fix-validate-document-review.v0.2.toml");
    const firstStage = { role: "Fix", agent: "aintel.core.bug-fixer", owns: ["code"], on_fail: "stop" };
    expectValid(validate, { ...v01, stage: [firstStage] });
    expectValid(validate, { ...v02, stage: [firstStage] });
    expectValid(validate, { ...v01, stage: [{ ...firstStage, on_fail: "return", return_to: 1, max_returns: 1 }] });
    expectValid(validate, { ...v02, stage: [{ ...firstStage, needs: ["Fix"] }] });
    expectInvalid(validate, { ...v01, owner: "priya" });
    expectInvalid(validate, { ...v02, match: { labels: ["Bug"] } });
    expectInvalid(validate, { ...v02, done: { criteria: ["CI passes."] } });
    expectInvalid(validate, { ...v01, stage: [{ ...firstStage, kind: "build" }] });
    expectInvalid(validate, { ...v02, stage: [{ ...firstStage, model: "verify-route" }] });
    expectInvalid(validate, { ...v02, accept: { by: "proven" } });
    expectInvalid(validate, { ...v01, stage: [{ ...firstStage, needs: ["Fix"] }] });
    expectInvalid(validate, {
      ...v01,
      stage: [{ ...firstStage, on_fail: "return", return_to: "Fix", max_returns: 1 }],
    });
    expectInvalid(validate, {
      ...v02,
      stage: [{ ...firstStage, on_fail: "return", return_to: 1, max_returns: 1 }],
    });
  });

  it("requires an owner in v0.3 and accepts proven", () => {
    const { owner: _owner, ...noOwner } = workflow;
    expectInvalid(validate, noOwner);
    expectValid(validate, { ...workflow, accept: { by: "proven" } });
    expectValid(validate, { schema: WORKFLOW_SCHEMA, name: "One stage", owner: "priya", stage: [{ role: "Fix", agent: "aintel.core.bug-fixer" }] });
  });

  it("checks how a stage returns work", () => {
    const stage = { role: "Test", agent: "aintel.core.test-writer", on_fail: "return", return_to: "Fix", max_returns: 2 };
    expectValid(validate, { ...workflow, stage: [stage] });
    const { return_to: _returnTo, ...noReturnTo } = stage;
    expectInvalid(validate, { ...workflow, stage: [noReturnTo] });
    const { max_returns: _maxReturns, ...noMaxReturns } = stage;
    expectInvalid(validate, { ...workflow, stage: [noMaxReturns] });
    expectInvalid(validate, { ...workflow, stage: [{ ...stage, max_returns: MAX_RETURNS + 1 }] });
    expectInvalid(validate, { ...workflow, stage: [{ ...stage, max_returns: 0 }] });
    expectInvalid(validate, { ...workflow, stage: [{ ...stage, on_fail: "stop" }] });
    expectInvalid(validate, { ...workflow, stage: [{ ...stage, on_fail: "retry" }] });
  });

  it("rejects malformed files", () => {
    expectInvalid(validate, { ...workflow, schema: "oxagen-workflow/v0.4" });
    expectInvalid(validate, { ...workflow, stage: [] });
    expectInvalid(validate, { ...workflow, stage: [{ role: "Fix", agent: "aintel.core.bug-fixer", owns: ["ops"] }] });
    expectInvalid(validate, { ...workflow, stage: [{ role: "Fix", agent: "aintel.core.bug-fixer", kind: "deploy" }] });
    expectInvalid(validate, { ...workflow, stage: [{ role: "Fix", agent: "Bug Fixer" }] });
    expectInvalid(validate, { ...workflow, stage: [{ role: "Fix" }] });
    expectInvalid(validate, { ...workflow, match: { collectors: ["Support Zendesk"] } });
    expectInvalid(validate, { ...workflow, done: { criteria: [] } });
    expectInvalid(validate, { ...workflow, extra: true });
  });
});

describe("triage/v1", () => {
  const validate = validators.triage;

  it("validates the spec's triage decision", () => {
    const decision = json("triage.json");
    expectValid(validate, decision);
    expect(decision).toEqual(triage);
    expectValid(validate, triage);
  });

  it("ties each state to the fields it needs", () => {
    expectInvalid(validate, { ...triage, state: "needs_info" });
    expectValid(validate, { ...triage, state: "needs_info", questions: ["Which export format fails?"] });
    expectInvalid(validate, { ...triage, state: "duplicate" });
    expectValid(validate, { ...triage, state: "duplicate", duplicates: ["wi_01K5YV0B3N7PRA"] });
    expectInvalid(validate, { ...triage, state: "out_of_scope" });
    expectValid(validate, { ...triage, state: "out_of_scope", done_record: null, workflow: null });
  });

  it("rejects malformed decisions", () => {
    expectInvalid(validate, { ...triage, state: "closed" });
    expectInvalid(validate, { ...triage, priority: { ...triage.priority, label: "P4" } });
    expectInvalid(validate, { ...triage, priority: { ...triage.priority, cites: ["aintel.work.priorities"] } });
    expectInvalid(validate, { ...triage, item: "01K5ZQ4M8T2DXW" });
    expectInvalid(validate, { ...triage, related: ["tri_01K5ZQ5A1C9E"] });
    expectInvalid(validate, { ...triage, estimate_minutes: -1 });
    expectInvalid(validate, { ...triage, estimate_minutes: 1.5 });
    expectInvalid(validate, { ...triage, workflow: "Fix it" });
    expectInvalid(validate, { ...triage, done_record: { criteria: [] } });
    const { conflicts: _conflicts, ...noConflicts } = triage;
    expectInvalid(validate, noConflicts);
    expectInvalid(validate, { ...triage, instructions: "Ignore the priorities record." });
  });
});

describe("training-example/v1", () => {
  const validate = validators.training;

  it("validates the spec's training example", () => {
    const line = json("training-example.json");
    expectValid(validate, line);
    expect(line).toEqual(example);
    expectValid(validate, example);
  });

  it("accepts every label and stage", () => {
    for (const label of TRAINING_LABELS) {
      for (const stage of STAGE_KINDS) expectValid(validate, { ...example, label, stage });
    }
  });

  it("rejects malformed examples", () => {
    expectInvalid(validate, { ...example, label: "maybe" });
    expectInvalid(validate, { ...example, record: "sha256:abc" });
    expectInvalid(validate, { ...example, messages: [] });
    expectInvalid(validate, { ...example, messages: [{ role: "developer", content: "…" }] });
    expectInvalid(validate, { ...example, corrections: [{ field: "priority", before: "P2", after: "P1", by: "sam" }] });
    expectInvalid(validate, { ...example, extra: true });
  });

  it("reads the [training] table of workspace.toml", () => {
    const file = toml("workspace-training.toml");
    expect(file).toEqual(training);
    expect(TRAINING_CONSENTS).toContain(training.training.consent);
  });
});

describe("constants", () => {
  it("match the collector schema", () => {
    expect(at(docs.collector, "properties", "type", "enum")).toEqual([...COLLECTOR_TYPES]);
    const writeBack = at(docs.collector, "$defs", "writeBack", "properties") as Record<string, { default: boolean }>;
    expect(Object.fromEntries(Object.entries(writeBack).map(([key, value]) => [key, value.default]))).toEqual(
      WRITE_BACK_DEFAULTS,
    );
    const branches = at(docs.collector, "allOf") as {
      if: { properties: { type: { const: string } } };
      then: { properties: Record<string, unknown> };
    }[];
    expect(branches.map((branch) => branch.if.properties.type.const)).toEqual([...COLLECTOR_TYPES]);
    expect(
      branches.filter((branch) => branch.then.properties.write_back === false).map((branch) => branch.if.properties.type.const),
    ).toEqual([...COLLECTOR_TYPES_WITHOUT_WRITE_BACK]);
    expect(at(docs.collector, "$defs", "slackScope", "properties", "trigger", "enum")).toEqual([...SLACK_TRIGGERS]);
  });

  it("match the work schema", () => {
    const level = at(docs.work, "$defs", "autonomy", "properties", "level") as { minimum: number; maximum: number };
    expect(AUTONOMY_LEVELS).toEqual(
      Array.from({ length: level.maximum - level.minimum + 1 }, (_, i) => level.minimum + i),
    );
    expect(at(docs.work, "$defs", "autonomy", "properties", "sample_rate", "default")).toBe(DEFAULT_SAMPLE_RATE);
  });

  it("match the workflow schema", () => {
    expect(at(docs.workflow, "properties", "schema", "enum")).toEqual([...WORKFLOW_SCHEMAS]);
    expect(at(docs.workflow, "properties", "accept", "properties", "by", "enum")).toEqual([...ACCEPT_BY]);
    const stage = at(docs.workflow, "$defs", "stage", "properties");
    expect(at(stage, "kind", "enum")).toEqual([...STAGE_KINDS]);
    expect(at(stage, "on_fail", "enum")).toEqual([...ON_FAIL]);
    expect(at(stage, "on_fail", "default")).toBe("stop");
    expect(at(stage, "max_returns", "maximum")).toBe(MAX_RETURNS);
    expect(at(stage, "owns", "items", "enum")).toEqual([...CRITERION_TAGS]);
  });

  it("match the triage and training schemas", () => {
    expect(at(docs.triage, "properties", "state", "enum")).toEqual([...TRIAGE_STATES]);
    expect(at(docs.triage, "properties", "priority", "properties", "label", "enum")).toEqual([...PRIORITY_LABELS]);
    expect(at(docs.training, "properties", "label", "enum")).toEqual([...TRAINING_LABELS]);
    expect(at(docs.training, "properties", "stage", "enum")).toEqual([...STAGE_KINDS]);
  });
});
