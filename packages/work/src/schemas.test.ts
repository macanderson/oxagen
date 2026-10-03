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
import {
  BRIEF_CRITERION_TAGS,
  BRIEF_INTENTS,
  BRIEF_PROVENANCES,
  CRITERION_ID_PATTERN,
  MAX_BRIEF_CRITERIA,
  REPOSITORY_PATTERN,
  WORK_BRIEF_SCHEMA,
  type WorkBrief,
  briefDigest,
  buildBrief,
  parseWorkBrief,
} from "./records/brief";
import { WORK_SCHEMA_IDS, type WorkSchemaId, schemaUrl, workSchemaPath, workSchemasDir } from "./schemas";
import {
  COLLECTOR_HEALTH,
  COLLECTOR_SCHEMA,
  COLLECTOR_TYPES,
  COLLECTOR_TYPES_WITHOUT_WRITE_BACK,
  type CollectorFile,
  type CollectorScopes,
  PRIORITY_LABELS,
  RECONCILE_INTERVAL_MINUTES,
  SLACK_TRIGGERS,
  TRIAGE_DECISIONS_PER_MINUTE,
  TRIAGE_SCHEMA,
  TRIAGE_STATES,
  type TriageDecision,
  WRITE_BACK_DEFAULTS,
} from "./types";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

function readSchema(id: WorkSchemaId): AnySchemaObject {
  return JSON.parse(readFileSync(workSchemaPath(id), "utf8")) as AnySchemaObject;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

const docs = {
  collector: readSchema(COLLECTOR_SCHEMA),
  triage: readSchema(TRIAGE_SCHEMA),
  brief: readSchema(WORK_BRIEF_SCHEMA),
};

const validators = {
  collector: ajv.compile(docs.collector),
  triage: ajv.compile(docs.triage),
  brief: ajv.compile(docs.brief),
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

// ---------------------------------------------------------------------------

describe("schema files", () => {
  it("publishes each schema at its id", () => {
    expect(SCHEMA_BASE_URL).toBe("https://oxagen.sh/schemas/");
    expect(schemaUrl("triage/v1")).toBe("https://oxagen.sh/schemas/triage/v1.json");
    expect(schemaUrl("work-brief/v1")).toBe("https://oxagen.sh/schemas/work-brief/v1.json");
    for (const id of WORK_SCHEMA_IDS) {
      const doc = readSchema(id);
      expect(doc.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(doc.$id).toBe(schemaUrl(id));
      expect(workSchemaPath(id)).toBe(join(workSchemasDir(), schemaFileName(id)));
    }
  });

  it("holds exactly the collector, triage, and work-brief schema files", () => {
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
    const { connection: _connection, ...noConnection } =
      zendesk as unknown as Record<string, unknown>;
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

describe("triage/v1", () => {
  const validate = validators.triage;

  it("validates the spec's triage decision", () => {
    const decision = json("triage.json");
    expectValid(validate, decision);
    expect(decision).toEqual(triage);
    expectValid(validate, triage);
  });

  it("ties each state to the fields it needs", () => {
    // Phase 1 runs no workflows, so a triaged decision may name none.
    expectValid(validate, { ...triage, workflow: null });
    expectInvalid(validate, { ...triage, done_record: null });
    expectValid(validate, {
      ...triage,
      state: "needs_info",
      questions: ["Which workflow fits?"],
      workflow: null,
      done_record: null,
    });
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

  it("match the triage schema", () => {
    expect(at(docs.triage, "properties", "state", "enum")).toEqual([...TRIAGE_STATES]);
    expect(at(docs.triage, "properties", "priority", "properties", "label", "enum")).toEqual([...PRIORITY_LABELS]);
  });

  it("fix the collector health states and the intake limits", () => {
    expect(COLLECTOR_HEALTH).toEqual(["healthy", "lagging", "failing", "paused"]);
    expect(RECONCILE_INTERVAL_MINUTES).toBe(15);
    expect(TRIAGE_DECISIONS_PER_MINUTE).toBe(60);
  });
});

describe("work-brief/v1", () => {
  const validate = validators.brief;
  const example: WorkBrief = {
    schema: "work-brief/v1",
    item: "wi_01k6aintelplatform612",
    item_revision: 2,
    repository: "aintel/platform",
    source: {
      url: "https://github.com/aintel/platform/issues/612",
      digest: "sha256:3f1c9a2e7b4d6085a1c3e5f7092b4d6e8a0c2e4f6081a3c5e7f9b1d3f5a7c9e1",
    },
    criteria: [
      {
        id: "c1",
        text: "An expired invite link shows the expiry message instead of a server error.",
        tag: "code",
        intent: "check",
        evidence: "invite.expired.test.ts passes",
        provenance: "source",
      },
      {
        id: "c3",
        text: "The invite page copy follows the house voice.",
        tag: "review",
        intent: "review",
        evidence: "",
        provenance: "person",
      },
    ],
  };

  it("validates the example, which matches its fixture and reads back unchanged", () => {
    expect(json("work-brief.json")).toEqual(example);
    expectValid(validate, example);
    expect(parseWorkBrief(json("work-brief.json"))).toEqual(example);
    expect(briefDigest(parseWorkBrief(json("work-brief.json")))).toBe(briefDigest(example));
  });

  it("validates every brief buildBrief writes", () => {
    const brief = buildBrief({
      item: "wi_01k6x",
      itemRevision: 1,
      source: { url: null, digest: null },
      draft: {
        repository: "aintel/platform",
        criteria: [{ text: "Docs name the new flag.", tag: "docs", intent: "review", provenance: "triage" }],
      },
      issuedIds: [],
    });
    expectValid(validate, brief);
  });

  it("rejects a verdict, a missing id, and an extra field", () => {
    expectInvalid(validate, { ...example, verdict: "held" });
    expectInvalid(validate, { ...example, criteria: [{ ...example.criteria[0], id: undefined }] });
    expectInvalid(validate, { ...example, criteria: [{ ...example.criteria[0], oracle: { class: "example" } }] });
    expectInvalid(validate, { ...example, criteria: [] });
    expectInvalid(validate, { ...example, repository: "platform" });
  });

  it("matches the constants the record code uses", () => {
    const criterion = at(docs.brief, "$defs", "criterion", "properties");
    expect(at(criterion, "tag", "enum")).toEqual([...BRIEF_CRITERION_TAGS]);
    expect(at(criterion, "intent", "enum")).toEqual([...BRIEF_INTENTS]);
    expect(at(criterion, "provenance", "enum")).toEqual([...BRIEF_PROVENANCES]);
    expect(at(criterion, "id", "pattern")).toBe(CRITERION_ID_PATTERN.source);
    expect(at(docs.brief, "properties", "repository", "pattern")).toBe(REPOSITORY_PATTERN.source);
    expect(at(docs.brief, "properties", "criteria", "maxItems")).toBe(MAX_BRIEF_CRITERIA);
    // The brief's tags are the done record's criterion tags.
    expect([...BRIEF_CRITERION_TAGS]).toEqual([...CRITERION_TAGS]);
  });
});
