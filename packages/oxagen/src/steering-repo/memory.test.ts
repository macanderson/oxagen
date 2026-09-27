import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURE_ROOT } from "./fixture-repo";
import { MEMORY_CAPTURES, memoryCaptureSchema, memorySchema } from "./memory";

type Issue = { path: (string | number)[]; code: string };

function issuesOf(value: unknown): Issue[] {
  const result = memorySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(({ path, code }) => ({ path, code }));
}

function fixture(folder: "stored" | "stored-invalid", name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, folder, name), "utf8")) as Record<
    string,
    unknown
  >;
}

const MEMORY = fixture("stored", "memory.json");

describe("memory", () => {
  it("accepts stored/memory.json", () => {
    expect(issuesOf(MEMORY)).toEqual([]);
  });

  it("refuses stored-invalid/memory-run-omitted.json, whose run is left out", () => {
    expect(issuesOf(fixture("stored-invalid", "memory-run-omitted.json"))).toEqual([
      { path: ["run"], code: "invalid_type" },
    ]);
  });

  it("names the three ways a memory reaches Oxagen", () => {
    expect(MEMORY_CAPTURES).toEqual(["remember", "pull_request", "local_gateway"]);
    expect(memoryCaptureSchema.options).toEqual([...MEMORY_CAPTURES]);
  });

  it.each(MEMORY_CAPTURES)("accepts the capture %s", (capture) => {
    expect(issuesOf({ ...MEMORY, capture })).toEqual([]);
  });

  it("accepts a null agent and a null run", () => {
    expect(issuesOf({ ...MEMORY, capture: "pull_request", agent: null, run: null })).toEqual([]);
  });

  it("accepts a memory that cites no evidence", () => {
    expect(issuesOf({ ...MEMORY, evidence: [] })).toEqual([]);
  });

  it("accepts a memory that names no repository, path, or tool", () => {
    const { repos: _repos, applies_to: _appliesTo, ...rest } = MEMORY;
    expect(issuesOf(rest)).toEqual([]);
  });

  it("accepts a statement of 2,000 characters", () => {
    expect(issuesOf({ ...MEMORY, statement: "x".repeat(2000) })).toEqual([]);
  });

  it.each([
    ["an unknown field", { colour: "blue" }, [], "unrecognized_keys"],
    ["another schema", { schema: "memory/v2" }, ["schema"], "invalid_literal"],
    ["an id with no mem_ prefix", { id: "01K5QK9A" }, ["id"], "invalid_string"],
    ["an agent that is not a lineage", { agent: "Release Bot" }, ["agent"], "invalid_string"],
    ["a run with no run_ prefix", { run: "01K5QK7D" }, ["run"], "invalid_string"],
    ["an unknown capture", { capture: "import" }, ["capture"], "invalid_enum_value"],
    ["an empty statement", { statement: "" }, ["statement"], "too_small"],
    ["a statement over 2,000 characters", { statement: "x".repeat(2001) }, ["statement"], "too_big"],
    ["an unknown kind", { kind: "rule" }, ["kind"], "invalid_enum_value"],
    ["an empty repos list", { repos: [] }, ["repos"], "too_small"],
    ["a repository that is not a reference", { repos: ["platform"] }, ["repos", 0], "invalid_string"],
    ["an empty applies_to entry", { applies_to: [""] }, ["applies_to", 0], "too_small"],
    ["an empty tools list", { tools: [] }, ["tools"], "too_small"],
    ["an empty evidence entry", { evidence: [""] }, ["evidence", 0], "too_small"],
    ["a time with no offset", { created_at: "2026-09-19 14:02" }, ["created_at"], "invalid_string"],
  ])("refuses %s", (_name, patch, path, code) => {
    expect(issuesOf({ ...MEMORY, ...patch })).toEqual([{ path, code }]);
  });

  it.each(["agent", "run", "capture", "statement", "kind", "evidence", "created_at"])(
    "requires %s",
    (field) => {
      const { [field]: _omitted, ...rest } = MEMORY;
      expect(issuesOf(rest)).toEqual([{ path: [field], code: "invalid_type" }]);
    },
  );
});
