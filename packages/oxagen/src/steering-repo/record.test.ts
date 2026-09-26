import { join } from "node:path";
import { jcsBytes, sha256Digest } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_ROOT,
  fixtureRepo,
  organizationFixtureRepo,
  readFixtureTree,
} from "./fixture-repo";
import { classifySteeringRepoPath } from "./paths";
import {
  effectiveLoad,
  isAlwaysOn,
  parseFrontmatter,
  readSteeringRecord,
  recordPreimage,
  recordSlug,
  recordStatement,
  splitRecordFile,
  stampRecord,
  STEERING_RECORD_FIELDS,
  steeringRecordSchema,
  type ParsedFrontmatter,
  type SteeringRecord,
} from "./record";

/** A valid steering record with no optional field set. */
const BASE = {
  schema: "steering-record/v1",
  lineage: "a-intel.test.rule",
  label: "Test rule",
  kind: "fact",
  force: "must",
  scope: "workspace",
  status: "active",
  origin: "user",
  provenance: { source: "proposal", uri: "oxagen:proposal/prp_1" },
} as const;

/** BASE as frontmatter lines. Line `i` sits on file line `i + 2`. */
const BASE_LINES = [
  "schema: steering-record/v1",
  "lineage: a-intel.test.rule",
  "label: Test rule",
  "kind: fact",
  "force: must",
  "scope: workspace",
  "status: active",
  "origin: user",
  "provenance:",
  "  source: proposal",
  "  uri: oxagen:proposal/prp_1",
];

/** A record file: the fences, the frontmatter lines, and the body after the closing fence. */
function recordFile(lines: readonly string[], body = "\nThe statement.\n"): string {
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function issuesOf(value: unknown): { path: (string | number)[]; message: string }[] {
  const result = steeringRecordSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(({ path, message }) => ({ path, message }));
}

function record(value: Record<string, unknown>): SteeringRecord {
  return steeringRecordSchema.parse({ ...BASE, ...value });
}

function frontmatterOf(text: string, firstLine?: number): ParsedFrontmatter {
  const parsed = parseFrontmatter(text, firstLine);
  if (!parsed.ok) {
    throw new Error(`expected the frontmatter to parse: ${JSON.stringify(parsed.issues)}`);
  }
  return parsed.frontmatter;
}

describe("steering record schema", () => {
  it("lists the frontmatter fields in the order Oxagen writes them", () => {
    expect(STEERING_RECORD_FIELDS).toEqual([
      "schema",
      "lineage",
      "label",
      "description",
      "kind",
      "name",
      "effect",
      "force",
      "scope",
      "repos",
      "tools",
      "skills",
      "applies_to",
      "load",
      "status",
      "origin",
      "provenance",
      "id",
      "hash",
    ]);
  });

  it("accepts a record with only the required fields", () => {
    expect(issuesOf(BASE)).toEqual([]);
  });

  it("accepts every optional field together", () => {
    expect(
      issuesOf({
        ...BASE,
        description: "One line for the index.",
        repos: ["github.com/a-intel/platform"],
        tools: ["billing__create_refund", "stripe__*"],
        skills: ["a-intel.brand.voice"],
        applies_to: ["src/**"],
        load: "match",
        id: "rec_a_intel_test_rule_0123456789ab",
        hash: `sha256:${"a".repeat(64)}`,
      }),
    ).toEqual([]);
  });

  it("requires effect on a constraint", () => {
    expect(issuesOf({ ...BASE, kind: "constraint" })).toEqual([
      { path: ["effect"], message: "effect is required when kind is constraint" },
    ]);
    expect(issuesOf({ ...BASE, kind: "constraint", effect: "forbid" })).toEqual([]);
  });

  it("requires name and description on a skill", () => {
    expect(issuesOf({ ...BASE, kind: "skill" })).toEqual([
      { path: ["name"], message: "name is required when kind is skill" },
      { path: ["description"], message: "description is required when kind is skill" },
    ]);
    expect(
      issuesOf({ ...BASE, kind: "skill", name: "test-skill", description: "Does a thing." }),
    ).toEqual([]);
  });

  it("requires repos when the scope is repository", () => {
    expect(issuesOf({ ...BASE, scope: "repository" })).toEqual([
      { path: ["repos"], message: "repos is required when scope is repository" },
    ]);
    expect(
      issuesOf({ ...BASE, scope: "repository", repos: ["github.com/a-intel/platform"] }),
    ).toEqual([]);
  });

  it("holds a description to 200 characters on every kind but a skill", () => {
    expect(issuesOf({ ...BASE, description: "x".repeat(200) })).toEqual([]);
    expect(issuesOf({ ...BASE, description: "x".repeat(201) })).toEqual([
      {
        path: ["description"],
        message: "description is at most 200 characters when kind is not skill",
      },
    ]);
  });

  it("holds a skill's description to 1,024 characters", () => {
    const skill = { ...BASE, kind: "skill", name: "test-skill" };
    expect(issuesOf({ ...skill, description: "x".repeat(1024) })).toEqual([]);
    expect(issuesOf({ ...skill, description: "x".repeat(1025) })).toEqual([
      { path: ["description"], message: expect.stringContaining("1024") },
    ]);
  });

  it.each([
    ["repos", "github.com/a-intel/platform"],
    ["tools", "billing__create_refund"],
    ["skills", "a-intel.brand.voice"],
  ])("refuses the same entry twice in %s", (field, entry) => {
    expect(issuesOf({ ...BASE, [field]: [entry, entry] })).toEqual([
      { path: [field, 1], message: `${field} lists ${JSON.stringify(entry)} twice` },
    ]);
  });

  it.each([
    ["an empty label", { label: "" }, ["label"]],
    ["a label over 36 characters", { label: "x".repeat(37) }, ["label"]],
    ["an unknown kind", { kind: "rule" }, ["kind"]],
    ["the effect allow", { kind: "constraint", effect: "allow" }, ["effect"]],
    ["a name with capitals", { name: "Test_Skill" }, ["name"]],
    ["an empty repos list", { repos: [] }, ["repos"]],
    ["an empty applies_to entry", { applies_to: [""] }, ["applies_to", 0]],
    ["an unknown load", { load: "never" }, ["load"]],
    ["a provenance field it does not know", { provenance: { ...BASE.provenance, by: "x" } }, ["provenance"]],
    ["an id Oxagen would not write", { id: "rec_x" }, ["id"]],
    ["a hash with no sha256 prefix", { hash: "a".repeat(64) }, ["hash"]],
    ["another schema", { schema: "steering-record/v2" }, ["schema"]],
  ])("refuses %s", (_name, patch, path) => {
    const issues = issuesOf({ ...BASE, ...patch });
    expect(issues.map((issue) => issue.path)).toContainEqual(path);
  });
});

describe("effectiveLoad and isAlwaysOn", () => {
  it.each([
    { force: "must", load: undefined, status: "active", effective: "always", always_on: true },
    { force: "should", load: undefined, status: "active", effective: "always", always_on: true },
    { force: "may", load: undefined, status: "active", effective: "relevant", always_on: false },
    { force: "info", load: undefined, status: "active", effective: "relevant", always_on: false },
    { force: "must", load: "match", status: "active", effective: "match", always_on: false },
    { force: "should", load: "mention", status: "active", effective: "mention", always_on: false },
    { force: "may", load: "always", status: "active", effective: "always", always_on: false },
    { force: "must", load: "always", status: "active", effective: "always", always_on: true },
    { force: "must", load: undefined, status: "archived", effective: "always", always_on: false },
  ])(
    "force $force, load $load, status $status loads $effective",
    ({ force, load, status, effective, always_on }) => {
      const value = record({ force, status, ...(load === undefined ? {} : { load }) });
      expect(effectiveLoad(value)).toBe(effective);
      expect(isAlwaysOn(value)).toBe(always_on);
    },
  );
});

describe("splitRecordFile", () => {
  it("splits at the two fences and names the body's first line", () => {
    expect(splitRecordFile("---\na: 1\nb: 2\n---\n\nBody\n")).toEqual({
      ok: true,
      parts: { frontmatter: "a: 1\nb: 2", body: "\nBody\n", body_line: 5 },
    });
  });

  it("refuses a file that does not open with a fence", () => {
    expect(splitRecordFile("a: 1\n---\n")).toEqual({
      ok: false,
      issue: { line: 1, field: null, message: "a record starts with --- on its own line" },
    });
  });

  it("refuses a frontmatter with no closing fence", () => {
    expect(splitRecordFile("---\na: 1\n")).toEqual({
      ok: false,
      issue: { line: 1, field: null, message: "the frontmatter has no closing --- line" },
    });
  });
});

describe("parseFrontmatter", () => {
  it("returns the value and the file line of each top-level key", () => {
    const parsed = frontmatterOf("a: 1\nb:\n  - x\nc: text");
    expect(parsed.value).toEqual({ a: 1, b: ["x"], c: "text" });
    expect([...parsed.key_lines]).toEqual([
      ["a", 2],
      ["b", 3],
      ["c", 5],
    ]);
  });

  it("counts lines from a custom first line", () => {
    expect([...frontmatterOf("a: 1\nb: 2", 10).key_lines]).toEqual([
      ["a", 10],
      ["b", 11],
    ]);
    expect(parseFrontmatter("", 10)).toEqual({
      ok: false,
      issues: [{ line: 10, field: null, message: "the frontmatter is empty" }],
    });
    expect(parseFrontmatter("a: &x 1", 10)).toEqual({
      ok: false,
      issues: [
        { line: 10, field: null, message: "the frontmatter uses a YAML anchor. Write the value out." },
      ],
    });
  });

  it.each([
    ["an empty frontmatter", ""],
    ["a frontmatter of comments", "# nothing here"],
  ])("refuses %s", (_name, text) => {
    expect(parseFrontmatter(text)).toEqual({
      ok: false,
      issues: [{ line: 2, field: null, message: "the frontmatter is empty" }],
    });
  });

  it("refuses two YAML documents", () => {
    expect(parseFrontmatter("a: 1\n---\nb: 2")).toEqual({
      ok: false,
      issues: [
        {
          line: 2,
          field: null,
          message: "the frontmatter holds more than one YAML document",
        },
      ],
    });
  });

  it("refuses an anchor and the alias that uses it, each on its own line", () => {
    expect(parseFrontmatter("a: &x 1\nb: *x")).toEqual({
      ok: false,
      issues: [
        { line: 2, field: null, message: "the frontmatter uses a YAML anchor. Write the value out." },
        { line: 3, field: null, message: "the frontmatter uses a YAML alias. Write the value out." },
      ],
    });
  });

  it.each([
    ["a local tag", "a: !foo 1", "!foo"],
    ["a core tag", "a: !!str 1", "tag:yaml.org,2002:str"],
  ])("refuses %s", (_name, text, tag) => {
    expect(parseFrontmatter(text)).toEqual({
      ok: false,
      issues: [
        { line: 2, field: null, message: `the frontmatter uses the YAML tag ${tag}. Remove it.` },
      ],
    });
  });

  it.each([
    ["a list", "- a\n- b"],
    ["a string", "hello"],
    ["a null", "~"],
  ])("refuses %s in place of a mapping", (_name, text) => {
    expect(parseFrontmatter(text)).toEqual({
      ok: false,
      issues: [{ line: 2, field: null, message: "the frontmatter is not a mapping of fields" }],
    });
  });

  it.each([
    ["a YAML syntax error", "a: [1, 2\nb: 3", "Flow sequence in block collection"],
    ["a duplicate key", "a: 1\na: 2", "Map keys must be unique"],
  ])("reports %s on its file line, in one line of text", (_name, text, fragment) => {
    const parsed = parseFrontmatter(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([
      { line: 3, field: null, message: expect.stringContaining(fragment) },
    ]);
    expect(parsed.issues.every((issue) => !issue.message.includes("\n"))).toBe(true);
  });

  it("parses a key that is not a scalar, and gives it no line", () => {
    const parsed = frontmatterOf("? [a, b]\n: x\nc: 1");
    expect(parsed.value.c).toBe(1);
    expect([...parsed.key_lines]).toEqual([["c", 4]]);
  });
});

describe("readSteeringRecord", () => {
  it("reads a valid steering record, its body, and the body's first line", () => {
    expect(readSteeringRecord(recordFile(BASE_LINES))).toEqual({
      ok: true,
      record: BASE,
      body: "\nThe statement.\n",
      body_line: 14,
    });
  });

  it.each([
    ["an empty file", "", { line: null, field: null, message: "the file is empty" }],
    [
      "a file with no final newline",
      "---\na: 1\n---\nBody",
      { line: 4, field: null, message: "the file does not end with a newline" },
    ],
    [
      "a file with no opening fence",
      "no fence\n",
      { line: 1, field: null, message: "a record starts with --- on its own line" },
    ],
    [
      "a file with no closing fence",
      "---\nschema: steering-record/v1\n",
      { line: 1, field: null, message: "the frontmatter has no closing --- line" },
    ],
    [
      "an empty frontmatter",
      "---\n---\n\nBody\n",
      { line: 2, field: null, message: "the frontmatter is empty" },
    ],
    [
      "an anchor in the frontmatter",
      "---\nlabel: &x Test rule\n---\n\nBody\n",
      { line: 2, field: null, message: "the frontmatter uses a YAML anchor. Write the value out." },
    ],
  ])("stops at %s", (_name, text, issue) => {
    expect(readSteeringRecord(text)).toEqual({ ok: false, issues: [issue] });
  });

  it("puts a schema issue on the line of the field it names", () => {
    const lines = BASE_LINES.map((line) => (line === "kind: fact" ? "kind: rule" : line));
    expect(readSteeringRecord(recordFile(lines))).toEqual({
      ok: false,
      issues: [{ line: 5, field: "kind", message: expect.stringContaining("received 'rule'") }],
    });
  });

  it("gives a missing field no line", () => {
    const lines = BASE_LINES.filter((line) => line !== "force: must");
    expect(readSteeringRecord(recordFile(lines))).toEqual({
      ok: false,
      issues: [{ line: null, field: "force", message: "Required" }],
    });
  });

  it("puts an unknown field on its own line", () => {
    expect(readSteeringRecord(recordFile([...BASE_LINES, "colour: blue"]))).toEqual({
      ok: false,
      issues: [
        {
          line: 13,
          field: "colour",
          message: "colour is not a known field. Remove it or check its spelling.",
        },
      ],
    });
  });

  it("gives a cross-field rule no line when the field it requires is absent", () => {
    const lines = BASE_LINES.map((line) => (line === "kind: fact" ? "kind: constraint" : line));
    expect(readSteeringRecord(recordFile(lines))).toEqual({
      ok: false,
      issues: [{ line: null, field: "effect", message: "effect is required when kind is constraint" }],
    });
  });

  it("puts a cross-field rule on the line of the field it limits", () => {
    const lines = [...BASE_LINES, `description: ${"x".repeat(201)}`];
    expect(readSteeringRecord(recordFile(lines))).toEqual({
      ok: false,
      issues: [
        {
          line: 13,
          field: "description",
          message: "description is at most 200 characters when kind is not skill",
        },
      ],
    });
  });

  it("refuses an empty body on the line it would start", () => {
    expect(readSteeringRecord(recordFile(BASE_LINES, "\n  \n"))).toEqual({
      ok: false,
      issues: [
        {
          line: 14,
          field: null,
          message: "the body is empty. Write the statement below the frontmatter.",
        },
      ],
    });
  });

  it("reports a schema issue and an empty body together", () => {
    const lines = BASE_LINES.filter((line) => line !== "force: must");
    expect(readSteeringRecord(recordFile(lines, "\n"))).toEqual({
      ok: false,
      issues: [
        { line: null, field: "force", message: "Required" },
        {
          line: 13,
          field: null,
          message: "the body is empty. Write the statement below the frontmatter.",
        },
      ],
    });
  });
});

describe("steering record identity", () => {
  it.each([
    ["LF text", "line one\nline two", "line one\nline two"],
    ["CRLF line endings", "line one\r\nline two\r\n", "line one\nline two"],
    ["blank lines around the text", "\n\nText\n\n\n", "Text"],
    ["leading spaces", "  indented\n", "  indented"],
  ])("recordStatement normalizes %s", (_name, body, statement) => {
    expect(recordStatement(body)).toBe(statement);
  });

  it.each([
    ["a-intel.brand.voice", "a_intel_brand_voice"],
    ["A-Intel.Core-Platform.X", "a_intel_core_platform_x"],
  ])("recordSlug spells %s as %s", (lineage, slug) => {
    expect(recordSlug(lineage)).toBe(slug);
  });

  it("builds the preimage without id, hash, label, and empty values", () => {
    const preimage = recordPreimage(
      {
        lineage: "a-intel.test.rule",
        id: "rec_a_intel_test_rule_0123456789ab",
        hash: `sha256:${"a".repeat(64)}`,
        label: "Test rule",
        description: null,
        load: undefined,
        kind: "fact",
        force: "must",
      },
      "\nThe statement.\r\n",
    );
    expect(Object.keys(preimage)).toEqual(["lineage", "kind", "force", "statement"]);
    expect(preimage).toEqual({
      lineage: "a-intel.test.rule",
      kind: "fact",
      force: "must",
      statement: "The statement.",
    });
  });

  it("stamps an id from the first hash and a hash that includes the id", () => {
    const preimage = recordPreimage(BASE, "The statement.");
    const seed = sha256Digest(jcsBytes(preimage));
    const id = `rec_a_intel_test_rule_${seed.slice(7, 19)}`;
    const stamp = stampRecord(BASE, "The statement.");
    expect(stamp).toEqual({ id, hash: sha256Digest(jcsBytes({ ...preimage, id })) });
    expect(stamp.id).toMatch(/^rec_a_intel_test_rule_[0-9a-f]{12}$/);
    expect(stamp.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("keeps the stamp when only the label, the stamp, empty values, or blank lines change", () => {
    const stamp = stampRecord(BASE, "The statement.");
    expect(
      stampRecord(
        {
          ...BASE,
          label: "Another label",
          id: stamp.id,
          hash: stamp.hash,
          description: null,
        },
        "\n\nThe statement.\r\n\n",
      ),
    ).toEqual(stamp);
  });

  it("changes the stamp when a field or the statement changes", () => {
    const stamp = stampRecord(BASE, "The statement.");
    const forced = stampRecord({ ...BASE, force: "should" }, "The statement.");
    const reworded = stampRecord(BASE, "Another statement.");
    expect(forced.id).not.toBe(stamp.id);
    expect(forced.hash).not.toBe(stamp.hash);
    expect(reworded.id).not.toBe(stamp.id);
    expect(reworded.hash).not.toBe(stamp.hash);
  });
});

const FIXTURE_TREES: ReadonlyArray<[string, Map<string, string>]> = [
  ["repo", fixtureRepo()],
  ["org-repo", organizationFixtureRepo()],
  ["v0.1/expected", readFixtureTree(join(FIXTURE_ROOT, "v0.1", "expected"))],
];

const FIXTURE_RECORDS = FIXTURE_TREES.flatMap(([tree, files]) =>
  [...files]
    .filter(([path]) => {
      const kind = classifySteeringRepoPath(path);
      return kind === "record" || kind === "skill-record";
    })
    .map(([path, text]) => ({ tree, name: `${tree}/${path}`, text })),
);

describe("fixture steering records", () => {
  it.each(FIXTURE_TREES.map(([tree]) => tree))("%s holds at least one steering record", (tree) => {
    expect(FIXTURE_RECORDS.some((entry) => entry.tree === tree)).toBe(true);
  });

  it.each(FIXTURE_RECORDS)("$name reads as a valid steering record", ({ text }) => {
    const read = readSteeringRecord(text);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    expect(read.record.id).toMatch(/^rec_/);
    expect(read.record.hash).toMatch(/^sha256:/);
  });

  it.each(FIXTURE_RECORDS)("$name stamps to the id and hash in its own frontmatter", ({ text }) => {
    const split = splitRecordFile(text);
    if (!split.ok) throw new Error(split.issue.message);
    const { value } = frontmatterOf(split.parts.frontmatter);
    expect(value.id).toBeDefined();
    expect(stampRecord(value, split.parts.body)).toEqual({ id: value.id, hash: value.hash });
  });
});
