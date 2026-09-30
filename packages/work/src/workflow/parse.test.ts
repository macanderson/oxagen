// parse.test.ts: parseWorkflow against the spec's three example files, one
// case per problem it reports, and the published JSON Schema. A document the
// schema rejects, the parser rejects too. A document that breaks only a graph
// rule passes the schema and fails the parser, because the schema cannot see
// the graph.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnySchemaObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { workSchemaPath } from "../schemas";
import { WORKFLOW_SCHEMA } from "../types";
import {
  isWorkflowSlug,
  parseWorkflow,
  type ResolvedStage,
  type ResolvedWorkflow,
  WORKFLOW_PROBLEM_CODES,
  type WorkflowProblem,
  type WorkflowProblemCode,
} from "./parse";

const FIXTURES = fileURLToPath(new URL("../../fixtures/workflows/", import.meta.url));

const fixtureDoc = (file: string): unknown => parseToml(readFileSync(join(FIXTURES, file), "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const schema = JSON.parse(readFileSync(workSchemaPath(WORKFLOW_SCHEMA), "utf8")) as AnySchemaObject;
const validate = ajv.compile(schema);

type Doc = Record<string, unknown>;

const FIX_AGENT = "aintel.core.bug-fixer";
const TEST_AGENT = "aintel.core.test-writer";
const FIX: Doc = { role: "Fix", agent: FIX_AGENT };
const TEST: Doc = {
  role: "Test",
  agent: TEST_AGENT,
  needs: ["Fix"],
  on_fail: "return",
  return_to: "Fix",
  max_returns: 2,
};

/** A small valid v0.3 file: Fix, then Test, which may return to Fix twice. */
function v3(extra: Doc = {}): Doc {
  return { schema: "oxagen-workflow/v0.3", name: "Fix and test", owner: "priya", stage: [FIX, TEST], ...extra };
}

/** The same two stages in v0.1, where return_to is a stage number. */
function v1(test: Doc = {}, extra: Doc = {}): Doc {
  const stage = { role: "Test", agent: TEST_AGENT, on_fail: "return", return_to: 1, max_returns: 2, ...test };
  return { schema: "oxagen-workflow/v0.1", name: "Fix and test", stage: [FIX, stage], ...extra };
}

function v2(extra: Doc = {}): Doc {
  return { schema: "oxagen-workflow/v0.2", name: "Fix and test", stage: [FIX, TEST], ...extra };
}

function without(doc: Doc, key: string): Doc {
  return Object.fromEntries(Object.entries(doc).filter(([name]) => name !== key));
}

const problem = (code: WorkflowProblemCode, path: string, message: string): WorkflowProblem => ({ code, path, message });

function resolved(doc: unknown, slug = "fix-and-test"): ResolvedWorkflow {
  const result = parseWorkflow(doc, slug);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.workflow;
}

function stage(fields: Partial<ResolvedStage> & Pick<ResolvedStage, "role" | "index" | "agent">): ResolvedStage {
  return {
    kind: "build",
    model: null,
    owns: [],
    needs: [],
    onFail: "stop",
    returnTo: null,
    maxReturns: 0,
    ...fields,
  };
}

describe("parseWorkflow on the spec's example files", () => {
  it("resolves the v0.3 fix-test-verify-review file", () => {
    expect(resolved(fixtureDoc("fix-test-verify-review.toml"), "fix-test-verify-review")).toEqual({
      slug: "fix-test-verify-review",
      schema: "oxagen-workflow/v0.3",
      name: "Fix, test, verify, review",
      owner: "priya",
      match: { labels: ["Bug"], collectors: ["support-zendesk", "github-core"] },
      doneCriteria: ["A test fails before the change and passes after it.", "CI passes on the pull request."],
      stages: [
        stage({ role: "Fix", index: 0, agent: FIX_AGENT, owns: ["code"] }),
        stage({
          role: "Test",
          index: 1,
          kind: "test",
          agent: TEST_AGENT,
          owns: ["test"],
          needs: ["Fix"],
          onFail: "return",
          returnTo: "Fix",
          maxReturns: 2,
        }),
        stage({
          role: "Verify",
          index: 2,
          kind: "verify",
          agent: "aintel.core.verifier",
          model: "verify-route",
          needs: ["Test"],
        }),
        stage({
          role: "Review",
          index: 3,
          kind: "review",
          agent: "aintel.core.architect",
          owns: ["review"],
          needs: ["Verify"],
          onFail: "return",
          returnTo: "Fix",
          maxReturns: 1,
        }),
      ],
      accept: { by: "operator", needs: ["Review"] },
    });
  });

  const olderStages = (validateNeeds: string[], documentNeeds: string[], reviewNeeds: string[]): ResolvedStage[] => [
    stage({ role: "Fix", index: 0, agent: FIX_AGENT, owns: ["code"] }),
    stage({
      role: "Validate",
      index: 1,
      agent: "aintel.core.validator",
      owns: ["test"],
      needs: validateNeeds,
      onFail: "return",
      returnTo: "Fix",
      maxReturns: 2,
    }),
    stage({ role: "Document", index: 2, agent: "aintel.core.documenter", owns: ["docs"], needs: documentNeeds }),
    stage({
      role: "Review",
      index: 3,
      agent: "aintel.core.architect",
      owns: ["review"],
      needs: reviewNeeds,
      onFail: "return",
      returnTo: "Fix",
      maxReturns: 1,
    }),
  ];

  it("reads the v0.1 file unchanged: each stage waits on the one before it, and return_to 1 names Fix", () => {
    const workflow = resolved(fixtureDoc("fix-validate-document-review.v0.1.toml"), "fix-validate-document-review");
    expect(workflow).toEqual({
      slug: "fix-validate-document-review",
      schema: "oxagen-workflow/v0.1",
      name: "Fix, validate, document, review",
      owner: null,
      match: { labels: [], collectors: [] },
      doneCriteria: [],
      stages: olderStages(["Fix"], ["Validate"], ["Document"]),
      accept: { by: "operator", needs: ["Review"] },
    });
  });

  it("reads the v0.2 file unchanged, with Validate and Document side by side", () => {
    const workflow = resolved(fixtureDoc("fix-validate-document-review.v0.2.toml"), "fix-validate-document-review");
    expect(workflow.schema).toBe("oxagen-workflow/v0.2");
    expect(workflow.stages).toEqual(olderStages(["Fix"], ["Fix"], ["Validate", "Document"]));
    expect(workflow.accept).toEqual({ by: "operator", needs: ["Review"] });
  });
});

describe("parseWorkflow defaults and tables", () => {
  it("reads a stage with no kind as build, with no returns, owning nothing", () => {
    expect(resolved(v3()).stages[0]).toEqual(stage({ role: "Fix", index: 0, agent: FIX_AGENT }));
  });

  it("accepts by operator when the file has no [accept] table", () => {
    expect(resolved(v2()).accept).toEqual({ by: "operator", needs: ["Test"] });
    expect(resolved(v3()).accept).toEqual({ by: "operator", needs: ["Test"] });
  });

  it("accepts by proven in v0.3", () => {
    expect(resolved(v3({ accept: { by: "proven" } })).accept).toEqual({ by: "proven", needs: ["Test"] });
  });

  it("makes [accept] need every stage no other stage needs", () => {
    const fork = v3({
      stage: [FIX, { role: "Docs", agent: "aintel.core.documenter", needs: ["Fix"] }, { ...TEST, return_to: "Fix" }],
    });
    expect(resolved(fork).accept.needs).toEqual(["Docs", "Test"]);
  });

  it("reads a table with a null prototype", () => {
    const fix = Object.assign(Object.create(null) as Doc, FIX);
    const doc = Object.assign(Object.create(null) as Doc, v3({ stage: [fix] }));
    expect(resolved(doc).stages).toEqual([stage({ role: "Fix", index: 0, agent: FIX_AGENT })]);
  });

  it("refuses a document that is a Date, a list, text, or null", () => {
    for (const doc of [new Date(0), [v3()], "schema = 1", null]) {
      expect(parseWorkflow(doc, "fix-and-test")).toEqual({
        ok: false,
        problems: [problem("not_a_table", "", "A workflow file must be a TOML table.")],
      });
    }
  });

  it("reports a bad file name with the document's own problems", () => {
    expect(parseWorkflow(null, "Fix Test")).toEqual({
      ok: false,
      problems: [
        problem("bad_value", "(file name)", "(file name) must be a slug such as fix-test-verify-review.toml."),
        problem("not_a_table", "", "A workflow file must be a TOML table."),
      ],
    });
  });

  it("reports every shape problem at once, and checks the graph only when the shape reads", () => {
    const doc = v3({
      name: "",
      stage: [
        { ...FIX, kind: "deploy" },
        { ...TEST, needs: ["Review"], max_returns: 0 },
        { role: "Review", agent: "aintel.core.architect", needs: ["Test"] },
      ],
    });
    expect(parseWorkflow(doc, "fix-and-test")).toEqual({
      ok: false,
      problems: [
        problem("bad_value", "name", "name must be a non-empty string."),
        problem("bad_value", "stage[0].kind", "stage[0].kind must be one of build, test, verify, review."),
        problem("bad_value", "stage[1].max_returns", "stage[1].max_returns must be a whole number from 1 to 3."),
      ],
    });
  });

  it("keeps a repeated done criterion, as the schema does", () => {
    const doc = v3({ done: { criteria: ["CI passes.", "CI passes."] } });
    expect(resolved(doc).doneCriteria).toEqual(["CI passes.", "CI passes."]);
    expect(validate(doc)).toBe(true);
  });
});

describe("isWorkflowSlug", () => {
  it("takes lowercase words joined by single hyphens, up to 64 characters", () => {
    expect(isWorkflowSlug("fix-test-verify-review")).toBe(true);
    expect(isWorkflowSlug("a".repeat(64))).toBe(true);
    for (const bad of ["Fix", "fix--test", "-fix", "fix-", "fix_test", "a".repeat(65), "", 3, null]) {
      expect(isWorkflowSlug(bad)).toBe(false);
    }
  });
});

interface ProblemCase {
  name: string;
  doc: unknown;
  slug?: string;
  problems: WorkflowProblem[];
}

const REVIEW: Doc = { role: "Review", agent: "aintel.core.architect" };

/** One document per problem the parser reports, with the exact problems it returns. */
const CASES: ProblemCase[] = [
  {
    name: "a document that is not a table",
    doc: ["schema"],
    problems: [problem("not_a_table", "", "A workflow file must be a TOML table.")],
  },
  {
    name: "a stage that is not a table",
    doc: v3({ stage: [FIX, "Test"] }),
    problems: [problem("not_a_table", "stage[1]", "stage[1] must be a [[stage]] table.")],
  },
  {
    name: "a [match] that is not a table",
    doc: v3({ match: ["Bug"] }),
    problems: [problem("not_a_table", "match", "match must be a [match] table.")],
  },
  {
    name: "a [done] that is not a table",
    doc: v3({ done: "CI passes." }),
    problems: [problem("not_a_table", "done", "done must be a [done] table.")],
  },
  {
    name: "an [accept] that is not a table",
    doc: v3({ accept: "operator" }),
    problems: [problem("not_a_table", "accept", "accept must be an [accept] table.")],
  },
  {
    name: "a top-level key the schema does not read",
    doc: v3({ labels: ["Bug"] }),
    problems: [problem("unknown_key", "labels", "labels is not a key this schema reads.")],
  },
  {
    name: "a stage key the schema does not read",
    doc: v3({ stage: [{ ...FIX, timeout: 30 }, TEST] }),
    problems: [problem("unknown_key", "stage[0].timeout", "stage[0].timeout is not a key this schema reads.")],
  },
  {
    name: "keys the [match], [done], and [accept] tables do not read",
    doc: v3({
      match: { labels: ["Bug"], teams: ["core"] },
      done: { criteria: ["CI passes."], notes: "none" },
      accept: { by: "operator", when: "always" },
    }),
    problems: [
      problem("unknown_key", "match.teams", "match.teams is not a key this schema reads."),
      problem("unknown_key", "done.notes", "done.notes is not a key this schema reads."),
      problem("unknown_key", "accept.when", "accept.when is not a key this schema reads."),
    ],
  },
  {
    name: "no schema",
    doc: without(v3(), "schema"),
    problems: [problem("missing_key", "schema", "schema is required.")],
  },
  {
    name: "no name",
    doc: without(v3(), "name"),
    problems: [problem("missing_key", "name", "name is required.")],
  },
  {
    name: "a v0.3 file with no owner",
    doc: without(v3(), "owner"),
    problems: [problem("missing_key", "owner", "owner is required.")],
  },
  {
    name: "no stages",
    doc: without(v3(), "stage"),
    problems: [problem("missing_key", "stage", "stage is required.")],
  },
  {
    name: "a stage with no role and no agent",
    doc: v3({ stage: [{}] }),
    problems: [
      problem("missing_key", "stage[0].role", "stage[0].role is required."),
      problem("missing_key", "stage[0].agent", "stage[0].agent is required."),
    ],
  },
  {
    name: "a stage that returns without saying where or how often",
    doc: v3({ stage: [FIX, { role: "Test", agent: TEST_AGENT, needs: ["Fix"], on_fail: "return" }] }),
    problems: [
      problem("missing_key", "stage[1].return_to", "stage[1].return_to is required."),
      problem("missing_key", "stage[1].max_returns", "stage[1].max_returns is required."),
    ],
  },
  {
    name: "a [done] table with no criteria",
    doc: v3({ done: {} }),
    problems: [problem("missing_key", "done.criteria", "done.criteria is required.")],
  },
  {
    name: "an [accept] table with no by",
    doc: v3({ accept: {} }),
    problems: [problem("missing_key", "accept.by", "accept.by is required.")],
  },
  {
    name: "a file name that is not a slug",
    doc: v3(),
    slug: "Fix and test",
    problems: [problem("bad_value", "(file name)", "(file name) must be a slug such as fix-test-verify-review.toml.")],
  },
  {
    name: "a schema version this parser does not read",
    doc: v3({ schema: "oxagen-workflow/v0.4" }),
    problems: [
      problem(
        "bad_value",
        "schema",
        "schema must be one of oxagen-workflow/v0.1, oxagen-workflow/v0.2, oxagen-workflow/v0.3.",
      ),
    ],
  },
  {
    name: "an empty name",
    doc: v3({ name: "" }),
    problems: [problem("bad_value", "name", "name must be a non-empty string.")],
  },
  {
    name: "an owner that is not a handle",
    doc: v3({ owner: "Priya" }),
    problems: [problem("bad_value", "owner", "owner must be a person's handle such as priya.")],
  },
  {
    name: "an empty stage list",
    doc: v3({ stage: [] }),
    problems: [problem("bad_value", "stage", "stage must be a list of at least one [[stage]].")],
  },
  {
    name: "a single [stage] table in place of a list",
    doc: v3({ stage: FIX }),
    problems: [problem("bad_value", "stage", "stage must be a list of at least one [[stage]].")],
  },
  {
    name: "a role that is not text",
    doc: v3({ stage: [{ ...FIX, role: 3 }, TEST] }),
    problems: [problem("bad_value", "stage[0].role", "stage[0].role must be a non-empty string.")],
  },
  {
    name: "an agent that is not a lineage",
    doc: v3({ stage: [{ ...FIX, agent: "Bug Fixer" }, TEST] }),
    problems: [
      problem("bad_value", "stage[0].agent", "stage[0].agent must be an agent lineage such as aintel.core.bug-fixer."),
    ],
  },
  {
    name: "a kind the schema does not name",
    doc: v3({ stage: [{ ...FIX, kind: "deploy" }, TEST] }),
    problems: [problem("bad_value", "stage[0].kind", "stage[0].kind must be one of build, test, verify, review.")],
  },
  {
    name: "an empty model",
    doc: v3({ stage: [{ ...FIX, model: "" }, TEST] }),
    problems: [problem("bad_value", "stage[0].model", "stage[0].model must be a model route.")],
  },
  {
    name: "owns that is not a list",
    doc: v3({ stage: [{ ...FIX, owns: "code" }, TEST] }),
    problems: [
      problem("bad_value", "stage[0].owns", "stage[0].owns must be a list of criterion tags (code, test, docs, review)."),
    ],
  },
  {
    name: "owns with a tag the schema does not name",
    doc: v3({ stage: [{ ...FIX, owns: ["code", "perf"] }, TEST] }),
    problems: [problem("bad_value", "stage[0].owns[1]", "stage[0].owns[1] must be one of code, test, docs, review.")],
  },
  {
    name: "owns with a repeated tag",
    doc: v3({ stage: [{ ...FIX, owns: ["code", "code"] }, TEST] }),
    problems: [problem("bad_value", "stage[0].owns", "stage[0].owns must be a list with no repeats. code appears twice.")],
  },
  {
    name: "empty needs",
    doc: v3({ stage: [FIX, { ...TEST, needs: [] }] }),
    problems: [problem("bad_value", "stage[1].needs", "stage[1].needs must be a list of one or more roles.")],
  },
  {
    name: "needs with an empty role",
    doc: v3({ stage: [FIX, { ...TEST, needs: [""] }] }),
    problems: [problem("bad_value", "stage[1].needs[0]", "stage[1].needs[0] must be a role.")],
  },
  {
    name: "an on_fail the schema does not name",
    doc: v3({ stage: [{ ...FIX, on_fail: "retry" }, TEST] }),
    problems: [problem("bad_value", "stage[0].on_fail", "stage[0].on_fail must be one of stop, return.")],
  },
  {
    name: "a stage number for return_to after v0.1",
    doc: v3({ stage: [FIX, { ...TEST, return_to: 1 }] }),
    problems: [problem("bad_value", "stage[1].return_to", "stage[1].return_to must be a role.")],
  },
  {
    name: "a role for return_to in v0.1",
    doc: v1({ return_to: "Fix" }),
    problems: [
      problem(
        "bad_value",
        "stage[1].return_to",
        "stage[1].return_to must be a stage number from 1 in oxagen-workflow/v0.1.",
      ),
    ],
  },
  {
    name: "more returns than the limit",
    doc: v3({ stage: [FIX, { ...TEST, max_returns: 4 }] }),
    problems: [problem("bad_value", "stage[1].max_returns", "stage[1].max_returns must be a whole number from 1 to 3.")],
  },
  {
    name: "an accept.by the schema does not name",
    doc: v3({ accept: { by: "robot" } }),
    problems: [problem("bad_value", "accept.by", "accept.by must be one of operator, proven.")],
  },
  {
    name: "match labels that are not a list",
    doc: v3({ match: { labels: "Bug" } }),
    problems: [problem("bad_value", "match.labels", "match.labels must be a list of labels.")],
  },
  {
    name: "a collector name that is not a slug",
    doc: v3({ match: { collectors: ["Support Zendesk"] } }),
    problems: [
      problem("bad_value", "match.collectors[0]", "match.collectors[0] must be a collector name such as support-zendesk."),
    ],
  },
  {
    name: "an empty criteria list",
    doc: v3({ done: { criteria: [] } }),
    problems: [problem("bad_value", "done.criteria", "done.criteria must be a list of one or more criteria.")],
  },
  {
    name: "kind and model in v0.2",
    doc: v2({ stage: [{ ...FIX, kind: "build", model: "route-a" }, TEST] }),
    problems: [
      problem(
        "not_in_version",
        "stage[0].kind",
        "stage[0].kind is not in oxagen-workflow/v0.2. It arrived in oxagen-workflow/v0.3.",
      ),
      problem(
        "not_in_version",
        "stage[0].model",
        "stage[0].model is not in oxagen-workflow/v0.2. It arrived in oxagen-workflow/v0.3.",
      ),
    ],
  },
  {
    name: "needs in v0.1",
    doc: v1({ needs: ["Fix"] }),
    problems: [
      problem(
        "not_in_version",
        "stage[1].needs",
        "stage[1].needs is not in oxagen-workflow/v0.1. It arrived in oxagen-workflow/v0.2.",
      ),
    ],
  },
  {
    name: "owner, [match], and [done] in v0.2",
    doc: v2({ owner: "priya", match: { labels: ["Bug"] }, done: { criteria: ["CI passes."] } }),
    problems: [
      problem("not_in_version", "owner", "owner is not in oxagen-workflow/v0.2. It arrived in oxagen-workflow/v0.3."),
      problem("not_in_version", "match", "match is not in oxagen-workflow/v0.2. It arrived in oxagen-workflow/v0.3."),
      problem("not_in_version", "done", "done is not in oxagen-workflow/v0.2. It arrived in oxagen-workflow/v0.3."),
    ],
  },
  {
    name: "accept by proven in v0.1",
    doc: v1({}, { accept: { by: "proven" } }),
    problems: [
      problem(
        "not_in_version",
        "accept.by",
        'by = "proven" is not in oxagen-workflow/v0.1. It arrived in oxagen-workflow/v0.3.',
      ),
    ],
  },
  {
    name: "return_to and max_returns on a stage that stops",
    doc: v3({ stage: [{ ...FIX, return_to: "Fix", max_returns: 1 }, TEST] }),
    problems: [
      problem("return_keys", "stage[0].return_to", "stage[0].return_to applies only when on_fail is return."),
      problem("return_keys", "stage[0].max_returns", "stage[0].max_returns applies only when on_fail is return."),
    ],
  },
  {
    name: "a role used twice",
    doc: v3({
      stage: [
        FIX,
        { role: "Test", agent: TEST_AGENT, needs: ["Fix"] },
        { role: "Test", agent: "aintel.core.architect", needs: ["Fix"] },
      ],
    }),
    problems: [problem("duplicate_role", "stage[2].role", "Role Test appears more than once.")],
  },
  {
    name: "a need that names no stage",
    doc: v3({ stage: [FIX, { role: "Test", agent: TEST_AGENT, needs: ["Build"] }] }),
    problems: [problem("unknown_need", "stage[1].needs", "Stage Test needs Build, which is not a role in this file.")],
  },
  {
    name: "a stage that needs itself",
    doc: v3({ stage: [FIX, { role: "Test", agent: TEST_AGENT, needs: ["Test"] }] }),
    problems: [
      problem("self_need", "stage[1].needs", "Stage Test cannot need itself."),
      problem("cycle", "stage", "needs forms a cycle: Test needs Test."),
    ],
  },
  {
    name: "a first stage with needs",
    doc: v3({ stage: [{ ...FIX, needs: ["Test"] }, { role: "Test", agent: TEST_AGENT, needs: ["Fix"] }] }),
    problems: [
      problem("first_stage_needs", "stage[0].needs", "The first stage runs at the send and has no needs."),
      problem("cycle", "stage", "needs forms a cycle: Fix needs Test needs Fix."),
    ],
  },
  {
    name: "needs that form a cycle",
    doc: v3({
      stage: [
        FIX,
        { role: "Test", agent: TEST_AGENT, needs: ["Review"], on_fail: "return", return_to: "Review", max_returns: 1 },
        { ...REVIEW, needs: ["Test"] },
      ],
    }),
    problems: [problem("cycle", "stage", "needs forms a cycle: Test needs Review needs Test.")],
  },
  {
    name: "a return to a role not in the file",
    doc: v3({ stage: [FIX, { ...TEST, return_to: "Build" }] }),
    problems: [
      problem("unknown_return", "stage[1].return_to", "Stage Test returns to Build, which is not a role in this file."),
    ],
  },
  {
    name: "a v0.1 return to a stage number past the end",
    doc: v1({ return_to: 3 }),
    problems: [problem("unknown_return", "stage[1].return_to", "Stage Test returns to stage 3, and the file has 2.")],
  },
  {
    name: "a return to a later stage",
    doc: v3({
      stage: [
        { ...FIX, on_fail: "return", return_to: "Test", max_returns: 1 },
        { role: "Test", agent: TEST_AGENT, needs: ["Fix"] },
      ],
    }),
    problems: [
      problem("return_not_upstream", "stage[0].return_to", "Stage Fix returns to Test, which does not hand off before it."),
    ],
  },
  {
    name: "a return to a stage on another branch",
    doc: v3({
      stage: [
        FIX,
        { role: "Docs", agent: "aintel.core.documenter", needs: ["Fix"] },
        { ...TEST, return_to: "Docs" },
      ],
    }),
    problems: [
      problem("return_not_upstream", "stage[2].return_to", "Stage Test returns to Docs, which does not hand off before it."),
    ],
  },
  {
    name: "a return to the stage itself",
    doc: v3({ stage: [FIX, { ...TEST, return_to: "Test" }] }),
    problems: [
      problem("return_not_upstream", "stage[1].return_to", "Stage Test returns to Test, which does not hand off before it."),
    ],
  },
];

/** The rules only the parser checks. The JSON Schema cannot see the stage graph. */
const GRAPH_CODES = new Set<WorkflowProblemCode>([
  "duplicate_role",
  "unknown_need",
  "self_need",
  "first_stage_needs",
  "cycle",
  "unknown_return",
  "return_not_upstream",
]);

describe("parseWorkflow problems", () => {
  it.each(CASES)("reports $name", ({ doc, slug, problems }) => {
    expect(parseWorkflow(doc, slug ?? "fix-and-test")).toEqual({ ok: false, problems });
  });

  it("has a case for every problem code, and source.ts reports not_toml", () => {
    const covered = new Set(CASES.flatMap((c) => c.problems.map((p) => p.code)));
    covered.add("not_toml");
    expect([...covered].sort()).toEqual([...WORKFLOW_PROBLEM_CODES].sort());
  });
});

describe("parseWorkflow and the oxagen-workflow/v0.3 JSON Schema", () => {
  it("both accept the spec's three example files", () => {
    const files = [
      ["fix-test-verify-review.toml", "fix-test-verify-review"],
      ["fix-validate-document-review.v0.1.toml", "fix-validate-document-review"],
      ["fix-validate-document-review.v0.2.toml", "fix-validate-document-review"],
    ] as const;
    for (const [file, slug] of files) {
      const doc = fixtureDoc(file);
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(parseWorkflow(doc, slug).ok).toBe(true);
    }
  });

  it("both accept the small files the other tests build on", () => {
    for (const doc of [v1(), v2(), v3(), v3({ accept: { by: "proven" } })]) {
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(parseWorkflow(doc, "fix-and-test").ok).toBe(true);
    }
  });

  // A case whose problems all break graph rules, or name only the file, is a
  // document the schema accepts. Every other case breaks the shape.
  const shapeCases = CASES.filter((c) => c.problems.some((p) => !GRAPH_CODES.has(p.code) && p.path !== "(file name)"));
  const schemaValidCases = CASES.filter((c) => !shapeCases.includes(c));

  it.each(shapeCases)("both reject $name", ({ doc }) => {
    expect(validate(doc)).toBe(false);
  });

  it.each(schemaValidCases)("the schema accepts $name, which only the parser refuses", ({ doc }) => {
    expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  });

  it("splits the cases into both groups", () => {
    expect(shapeCases.length).toBeGreaterThan(30);
    expect(schemaValidCases.map((c) => c.name)).toEqual([
      "a file name that is not a slug",
      "a role used twice",
      "a need that names no stage",
      "a stage that needs itself",
      "a first stage with needs",
      "needs that form a cycle",
      "a return to a role not in the file",
      "a v0.1 return to a stage number past the end",
      "a return to a later stage",
      "a return to a stage on another branch",
      "a return to the stage itself",
    ]);
  });
});
