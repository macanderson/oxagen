import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import { runOutcomeSchema } from "../contracts/run.list";
import { bundleSchema } from "./bundle";
import { FIXTURE_ROOT, fixtureRepo, readFixtureTree } from "./fixture-repo";
import { readJsonLines, readTomlFile } from "./files";
import { classifySteeringRepoPath } from "./paths";
import { promotionSchema } from "./promotion";
import { reflectionOutcomeSchema, reflectionSchema } from "./reflection";
import { embeddingsSchema, workspaceSchema, type WorkspaceFile } from "./workspace";

type Issue = { path: (string | number)[]; message: string };

function issuesOf(schema: ZodTypeAny, value: unknown): Issue[] {
  const result = schema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(({ path, message }) => ({ path, message }));
}

function stored(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(FIXTURE_ROOT, "stored", name), "utf8"),
  ) as Record<string, unknown>;
}

const REPO = fixtureRepo();

const WORKSPACE_FILES = (
  [
    ["repo", REPO],
    ["v0.1/expected", readFixtureTree(join(FIXTURE_ROOT, "v0.1", "expected"))],
  ] as const
).flatMap(([tree, files]) =>
  [...files]
    .filter(([path]) => classifySteeringRepoPath(path) === "workspace")
    .map(([path, text]) => ({ tree, name: `${tree}/${path}`, text })),
);

function workspaceText(tree: string): string {
  const entry = WORKSPACE_FILES.find((file) => file.tree === tree);
  if (entry === undefined) throw new Error(`${tree} has no workspace.toml`);
  return entry.text;
}

function readWorkspace(text: string): WorkspaceFile {
  const read = readTomlFile(text, "workspace/v1", workspaceSchema);
  if (!read.ok) throw new Error(JSON.stringify(read.issues));
  return read.value;
}

const ENDPOINT = "https://embeddings.a-intel.com/v1/embeddings";
const CREDENTIAL = "oxagen:credential/embeddings";

describe("workspace fixtures", () => {
  it.each(["repo", "v0.1/expected"])("%s holds a workspace.toml", (tree) => {
    expect(WORKSPACE_FILES.some((file) => file.tree === tree)).toBe(true);
  });

  it.each(WORKSPACE_FILES)("$name reads against workspace/v1", ({ text }) => {
    expect(readTomlFile(text, "workspace/v1", workspaceSchema).ok).toBe(true);
  });

  it("sets every table the schema knows in the workspace repo", () => {
    const file = readWorkspace(workspaceText("repo"));
    expect(Object.keys(file).sort()).toEqual(Object.keys(workspaceSchema.shape).sort());
    expect(file.embeddings?.provider).toBe("custom");
  });
});

describe("workspace schema", () => {
  const WORKSPACE = readWorkspace(workspaceText("repo"));
  const platform = { url: "github.com/a-intel/platform" };

  it("accepts a file that names only its organization and workspace", () => {
    expect(
      issuesOf(workspaceSchema, {
        schema: "workspace/v1",
        organization: WORKSPACE.organization,
        workspace: WORKSPACE.workspace,
      }),
    ).toEqual([]);
  });

  it("accepts an empty list of repositories", () => {
    expect(issuesOf(workspaceSchema, { ...WORKSPACE, repositories: [] })).toEqual([]);
  });

  it("refuses a repository listed twice", () => {
    expect(
      issuesOf(workspaceSchema, { ...WORKSPACE, repositories: [platform, platform] }),
    ).toEqual([
      {
        path: ["repositories", 1],
        message: 'repositories lists {"url":"github.com/a-intel/platform"} twice',
      },
    ]);
  });

  it("puts a repeated repository on the line of the first repositories table", () => {
    const original = workspaceText("repo");
    const text = original.replace(
      "github.com/a-intel/billing-service",
      "github.com/a-intel/platform",
    );
    expect(text).not.toBe(original);
    const line = text.split("\n").indexOf("[[repositories]]") + 1;
    expect(line).toBeGreaterThan(0);
    expect(readTomlFile(text, "workspace/v1", workspaceSchema)).toEqual({
      ok: false,
      issues: [
        {
          line,
          field: "repositories.1",
          message: 'repositories lists {"url":"github.com/a-intel/platform"} twice',
        },
      ],
    });
  });

  it("reports an embeddings rule under the embeddings table", () => {
    expect(
      issuesOf(workspaceSchema, {
        ...WORKSPACE,
        embeddings: { provider: "custom", model: "bge-large-en-v1.5" },
      }),
    ).toEqual([
      { path: ["embeddings", "url"], message: "url is required when provider is custom" },
    ]);
  });

  it.each([
    ["another schema", { schema: "workspace/v2" }, ["schema"]],
    ["an organization with capitals", { organization: "A-Intel" }, ["organization"]],
    ["a one-letter organization", { organization: "a" }, ["organization"]],
    ["a reserved workspace slug", { workspace: "audit" }, ["workspace"]],
    [
      "a repository written as a URL",
      { repositories: [{ url: "https://github.com/a-intel/platform" }] },
      ["repositories", 0, "url"],
    ],
    ["a repository field it does not know", { repositories: [{ ...platform, branch: "main" }] }, ["repositories", 0]],
    ["a negative budget", { budget: { per_month_micros: -1 } }, ["budget", "per_month_micros"]],
    ["a fractional budget", { budget: { per_month_micros: 1.5 } }, ["budget", "per_month_micros"]],
    ["a budget field it does not know", { budget: { per_day_micros: 1 } }, ["budget"]],
    ["block_merge as text", { code_checks: { block_merge: "no" } }, ["code_checks", "block_merge"]],
    ["a tool definition budget of zero", { tools: { definition_budget: 0 } }, ["tools", "definition_budget"]],
    ["a top-level field it does not know", { colour: "blue" }, []],
  ])("refuses %s", (_name, patch, path) => {
    const issues = issuesOf(workspaceSchema, { ...WORKSPACE, ...patch });
    expect(issues.map((issue) => issue.path)).toContainEqual(path);
  });
});

describe("embeddings", () => {
  it.each([
    ["no provider", {}],
    ["the oxagen provider", { provider: "oxagen" }],
    ["the keyword provider", { provider: "keyword" }],
    ["a custom endpoint with no credential", { provider: "custom", url: ENDPOINT, model: "bge-large-en-v1.5" }],
    [
      "a custom endpoint with a credential",
      { provider: "custom", url: ENDPOINT, model: "bge-large-en-v1.5", credential: CREDENTIAL },
    ],
  ])("accepts %s", (_name, value) => {
    expect(issuesOf(embeddingsSchema, value)).toEqual([]);
  });

  it.each([
    {
      name: "a custom provider with no endpoint or model",
      value: { provider: "custom" },
      issues: [
        { path: ["url"], message: "url is required when provider is custom" },
        { path: ["model"], message: "model is required when provider is custom" },
      ],
    },
    {
      name: "a custom provider with no model",
      value: { provider: "custom", url: ENDPOINT },
      issues: [{ path: ["model"], message: "model is required when provider is custom" }],
    },
    {
      name: "an endpoint for the oxagen provider",
      value: { provider: "oxagen", url: ENDPOINT },
      issues: [{ path: ["url"], message: "url is not allowed when provider is not custom" }],
    },
    {
      name: "a model with no provider",
      value: { model: "bge-large-en-v1.5" },
      issues: [{ path: ["model"], message: "model is not allowed when provider is not custom" }],
    },
    {
      name: "an endpoint, model and credential for the keyword provider",
      value: { provider: "keyword", url: ENDPOINT, model: "bge-large-en-v1.5", credential: CREDENTIAL },
      issues: [
        { path: ["url"], message: "url is not allowed when provider is not custom" },
        { path: ["model"], message: "model is not allowed when provider is not custom" },
        { path: ["credential"], message: "credential is not allowed when provider is not custom" },
      ],
    },
  ])("refuses $name", ({ value, issues }) => {
    expect(issuesOf(embeddingsSchema, value)).toEqual(issues);
  });

  it("checks no rule while the provider is unknown", () => {
    expect(issuesOf(embeddingsSchema, { provider: "voyage", url: ENDPOINT })).toEqual([
      {
        path: ["provider"],
        message: "Invalid enum value. Expected 'oxagen' | 'custom' | 'keyword', received 'voyage'",
      },
    ]);
  });

  it("refuses an endpoint that is not a URL", () => {
    expect(
      issuesOf(embeddingsSchema, { provider: "custom", url: "embeddings", model: "bge-large-en-v1.5" }),
    ).toEqual([{ path: ["url"], message: "Invalid url" }]);
  });

  it("refuses a model name longer than 200 characters", () => {
    expect(
      issuesOf(embeddingsSchema, { provider: "custom", url: ENDPOINT, model: "m".repeat(201) }),
    ).toEqual([{ path: ["model"], message: "String must contain at most 200 character(s)" }]);
  });

  it("refuses a credential that is not a reference", () => {
    expect(
      issuesOf(embeddingsSchema, {
        provider: "custom",
        url: ENDPOINT,
        model: "bge-large-en-v1.5",
        credential: "embeddings",
      }),
    ).toEqual([
      {
        path: ["credential"],
        message:
          "a credential is oxagen:credential/<name>, the name in lowercase letters, digits, and hyphens",
      },
    ]);
  });

  it.each([
    ["an empty model name", { provider: "custom", url: ENDPOINT, model: "" }, ["model"]],
    ["a field it does not know", { provider: "oxagen", endpoint: ENDPOINT }, []],
  ])("refuses %s", (_name, value, path) => {
    expect(issuesOf(embeddingsSchema, value).map((issue) => issue.path)).toContainEqual(path);
  });
});

describe("bundle", () => {
  const STORED = stored("bundle.json");
  const ORGANIZATION_BUNDLE = {
    schema: "bundle/v1",
    repository: "github.com/a-intel/oxagen",
    scope: "organization",
    organization: "a-intel",
    version: 1,
    commit: "78054f71905114b4bb66a30dfdbb922f98a5cd4d",
    ledger: null,
    published_at: "2026-09-22T13:45:30Z",
    records: [],
    always_on: [],
    policies: null,
    agents: [],
    tools: null,
  };

  it("accepts the stored bundle", () => {
    expect(issuesOf(bundleSchema, STORED)).toEqual([]);
  });

  it("names the last line of the fixture ledger in the stored bundle", () => {
    const ledger = [...REPO].find(([path]) => classifySteeringRepoPath(path) === "ledger");
    if (ledger === undefined) throw new Error("the fixture repo has no ledger");
    const [path, text] = ledger;
    const read = readJsonLines(text, promotionSchema);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    const last = read.value[read.value.length - 1];
    expect(last).toBeDefined();
    expect(STORED.ledger).toEqual({ path, seq: last?.seq, hash: last?.hash });
  });

  it("names the organization and workspace of the fixture workspace.toml", () => {
    const workspace = readWorkspace(workspaceText("repo"));
    expect(STORED.scope).toBe("workspace");
    expect(STORED.organization).toBe(workspace.organization);
    expect(STORED.workspace).toBe(workspace.workspace);
  });

  it.each([
    ["an organization bundle with no workspace", {}],
    ["a workspace bundle with its workspace", { scope: "workspace", workspace: "core-platform" }],
    ["a commit in a SHA-256 repository", { commit: "0123456789abcdef".repeat(4) }],
    ["a tool manifest with fields the manifest schema owns", { tools: { schema: "tool-manifest/v1", servers: [] } }],
  ])("accepts %s", (_name, patch) => {
    expect(issuesOf(bundleSchema, { ...ORGANIZATION_BUNDLE, ...patch })).toEqual([]);
  });

  it("requires a workspace when the scope is workspace", () => {
    expect(issuesOf(bundleSchema, { ...ORGANIZATION_BUNDLE, scope: "workspace" })).toEqual([
      { path: ["workspace"], message: "workspace is required when scope is workspace" },
    ]);
  });

  it("refuses a workspace when the scope is organization", () => {
    expect(
      issuesOf(bundleSchema, { ...ORGANIZATION_BUNDLE, workspace: "core-platform" }),
    ).toEqual([
      { path: ["workspace"], message: "workspace is not allowed when scope is organization" },
    ]);
  });

  it("checks no scope rule while the scope is unknown", () => {
    const issues = issuesOf(bundleSchema, {
      ...ORGANIZATION_BUNDLE,
      scope: "team",
      workspace: "core-platform",
    });
    expect(issues.map((issue) => issue.path)).toEqual([["scope"]]);
  });

  it.each([
    ["version zero", { version: 0 }, ["version"]],
    ["a short commit", { commit: "78054f7" }, ["commit"]],
    [
      "a ledger line at seq zero",
      {
        ledger: {
          path: "steering/promotions/2026-09.jsonl",
          seq: 0,
          hash: `sha256:${"0".repeat(64)}`,
        },
      },
      ["ledger", "seq"],
    ],
    ["another tool manifest schema", { tools: { schema: "tool-manifest/v2" } }, ["tools", "schema"]],
    ["a field it does not know", { colour: "blue" }, []],
  ])("refuses %s", (_name, patch, path) => {
    const issues = issuesOf(bundleSchema, { ...ORGANIZATION_BUNDLE, ...patch });
    expect(issues.map((issue) => issue.path)).toContainEqual(path);
  });
});

describe("reflection", () => {
  const REFLECTION = stored("reflection.json");
  const LESSON = {
    statement: "The CI cache key hashes pnpm-lock.yaml.",
    kind: "memory",
    evidence: ["frame:run_01K5QK7D/88"],
  };
  const grades = (work: unknown, tools: Record<string, unknown> = {}) => ({
    ...REFLECTION,
    grades: { work, tools },
  });

  it.each(["reflection.json", "reflection-clean.json"])("accepts stored/%s", (name) => {
    expect(issuesOf(reflectionSchema, stored(name))).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5])("accepts a work grade of %s", (work) => {
    expect(issuesOf(reflectionSchema, grades(work))).toEqual([]);
  });

  it.each([0, 6, 2.5])("refuses a work grade of %s", (work) => {
    expect(issuesOf(reflectionSchema, grades(work)).map((issue) => issue.path)).toEqual([
      ["grades", "work"],
    ]);
  });

  it("refuses a tool grade above 5", () => {
    expect(
      issuesOf(reflectionSchema, grades(3, { "billing__create_refund@3": 6 })).map(
        (issue) => issue.path,
      ),
    ).toEqual([["grades", "tools", "billing__create_refund@3"]]);
  });

  it("refuses a tool grade under a name that is not a tool reference", () => {
    expect(issuesOf(reflectionSchema, grades(3, { Billing: 3 }))).toEqual([
      {
        path: ["grades", "tools", "Billing"],
        message: "a tool reference is <server>__<tool>, optionally followed by @<version>",
      },
    ]);
  });

  it.each([0, 50])("accepts %s lessons", (count) => {
    const lessons = Array.from({ length: count }, () => LESSON);
    expect(issuesOf(reflectionSchema, { ...REFLECTION, lessons })).toEqual([]);
  });

  it("refuses 51 lessons", () => {
    const lessons = Array.from({ length: 51 }, () => LESSON);
    expect(issuesOf(reflectionSchema, { ...REFLECTION, lessons })).toEqual([
      { path: ["lessons"], message: "Array must contain at most 50 element(s)" },
    ]);
  });

  it("allows every run outcome but running", () => {
    expect(reflectionOutcomeSchema.options).toEqual(
      runOutcomeSchema.options.filter((outcome) => outcome !== "running"),
    );
  });

  it.each(reflectionOutcomeSchema.options)("accepts the outcome %s", (outcome) => {
    expect(issuesOf(reflectionSchema, { ...REFLECTION, outcome })).toEqual([]);
  });

  it("refuses the outcome running", () => {
    expect(
      issuesOf(reflectionSchema, { ...REFLECTION, outcome: "running" }).map((issue) => issue.path),
    ).toEqual([["outcome"]]);
  });

  it("accepts a lesson that names every tool of one server", () => {
    const lessons = [{ ...LESSON, tools: ["billing__*"] }];
    expect(issuesOf(reflectionSchema, { ...REFLECTION, lessons })).toEqual([]);
  });

  it.each([
    ["a lesson with no evidence", { evidence: [] }, ["lessons", 0, "evidence"]],
    ["evidence that names no frame", { evidence: ["frame:run_01K5QK7D"] }, ["lessons", 0, "evidence", 0]],
    ["an empty statement", { statement: "" }, ["lessons", 0, "statement"]],
    ["a statement longer than 2000 characters", { statement: "x".repeat(2001) }, ["lessons", 0, "statement"]],
    ["an unknown kind", { kind: "note" }, ["lessons", 0, "kind"]],
    ["an empty repos list", { repos: [] }, ["lessons", 0, "repos"]],
    ["an empty applies_to list", { applies_to: [] }, ["lessons", 0, "applies_to"]],
    ["an empty applies_to entry", { applies_to: [""] }, ["lessons", 0, "applies_to", 0]],
    ["an empty tools list", { tools: [] }, ["lessons", 0, "tools"]],
    ["a tool that is not a target", { tools: ["billing"] }, ["lessons", 0, "tools", 0]],
    ["a lesson field it does not know", { source: "chat" }, ["lessons", 0]],
  ])("refuses %s", (_name, patch, path) => {
    const lessons = [{ ...LESSON, ...patch }];
    const issues = issuesOf(reflectionSchema, { ...REFLECTION, lessons });
    expect(issues.map((issue) => issue.path)).toContainEqual(path);
  });

  it.each([
    ["a run id with no prefix", { run: "01K5QK7D" }, ["run"]],
    ["an agent name with capitals", { agent: "Release Bot" }, ["agent"]],
    ["an empty summary", { summary: "" }, ["summary"]],
    [
      "tool feedback with no problem",
      { tool_feedback: [{ tool: "billing__create_refund@3", problem: "" }] },
      ["tool_feedback", 0, "problem"],
    ],
    [
      "tool feedback on a bare server",
      { tool_feedback: [{ tool: "billing", problem: "slow" }] },
      ["tool_feedback", 0, "tool"],
    ],
    ["a field it does not know", { colour: "blue" }, []],
  ])("refuses %s", (_name, patch, path) => {
    const issues = issuesOf(reflectionSchema, { ...REFLECTION, ...patch });
    expect(issues.map((issue) => issue.path)).toContainEqual(path);
  });
});
