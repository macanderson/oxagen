// The agent wizard's file logic: the slug a description implies, the
// definition drafted from the draft, what the definition step reads back, and
// which belt picks park for a person.
import { describe, expect, it } from "vitest";
import {
  agentSlugFromDescription,
  beltPattern,
  type BeltTool,
  draftAgentDefinition,
  isAgentSlug,
  normalizeSlug,
  parks,
  readDefinition,
} from "./agent-file";

const COPY = {
  header: "The definition is the record.\nNothing is written to a database.",
  placeholder: "What this agent is for.",
  stayInside: "Work inside the toolbelt you were given.",
};

const draft = (
  over: Partial<Parameters<typeof draftAgentDefinition>[0]> = {},
) =>
  draftAgentDefinition({
    slug: "perf-watch",
    desc: "Watch the performance budget on every pull request.",
    tier: "complex",
    harness: "cursor",
    belt: [],
    copy: COPY,
    ...over,
  });

const TOOL: BeltTool = {
  slug: "github__create_pull_request",
  name: "Create pull request",
  version: 3,
  riskGrade: "medium",
  sideEffect: "write",
  financial: false,
  killed: false,
};

describe("the slug", () => {
  it("takes the first two words that are not filler", () => {
    expect(
      agentSlugFromDescription("Watch the performance budget on every PR"),
    ).toBe("watch-performance");
    expect(agentSlugFromDescription("Triage new issues")).toBe("triage-issues");
  });

  it("stays inside 18 characters without a trailing hyphen, and falls back when empty", () => {
    const slug = agentSlugFromDescription("Reconcile invoicesagainst orders");
    expect(slug.length).toBeLessThanOrEqual(18);
    expect(slug.endsWith("-")).toBe(false);
    expect(agentSlugFromDescription("   ")).toBe("new-agent");
    expect(agentSlugFromDescription("the a an")).toBe("new-agent");
  });

  it("accepts the register_agent shape and nothing else (negative)", () => {
    expect(isAgentSlug("perf-watch")).toBe(true);
    for (const bad of ["", "Perf", "perf--watch", "perf-", "a".repeat(19)]) {
      expect(isAgentSlug(bad)).toBe(false);
    }
  });

  it("normalizes what the operator types, keeping a trailing hyphen while they type", () => {
    expect(normalizeSlug("Perf Watch")).toBe("perf-watch");
    expect(normalizeSlug("--perf_")).toBe("perf-");
  });
});

describe("draftAgentDefinition", () => {
  it("writes the schema, the slug, the tier, the fallback belt, a budget and the harness table", () => {
    const file = draft();
    expect(file).toContain("# .oxagen/agents/perf-watch.toml");
    expect(file).toContain("# Nothing is written to a database.");
    expect(file).toContain('schema = "agent-definition/v0.1"');
    expect(file).toContain('slug = "perf-watch"');
    // The name the slug implies.
    expect(file).toContain('name = "Perf watch"');
    expect(file).toContain('model_tier = "complex"');
    // The fallback belt: two reads, nothing that writes.
    expect(file).toContain('tools = ["search_graph", "recall_memory"]');
    expect(file).toContain("budget = { per_run_micros = 4000000 }");
    expect(file).toContain("[harness.cursor]");
    const reading = readDefinition(file);
    expect(reading).toEqual({
      ok: true,
      slug: "perf-watch",
      tier: "complex",
      tools: 2,
      denied: 2,
    });
  });

  it("writes the picked belt instead of the fallback", () => {
    const file = draft({ belt: [beltPattern(TOOL)] });
    expect(file).toContain('tools = ["github__create_pull_request@3"]');
  });

  it("folds a long description to one line and keeps the whole of it as the instructions", () => {
    const long = `${"word ".repeat(40)}end`;
    const file = draft({ desc: long });
    const line = file.split("\n").find((l) => l.startsWith("description"));
    expect(line?.length).toBeLessThanOrEqual('description = ""'.length + 110);
    expect(line?.endsWith('…"')).toBe(true);
    expect(file).toContain(long);
  });

  it("escapes quotes and a triple quote so the file still parses (negative)", () => {
    const file = draft({ desc: 'Say "hi" and then """ close \\ it' });
    expect(file).toContain(
      'description = "Say \\"hi\\" and then \\"\\"\\" close \\\\ it"',
    );
    expect(readDefinition(file).ok).toBe(true);
  });

  it("leaves the harness table out while no harness is chosen, and uses the placeholder with no description", () => {
    const file = draft({ harness: null, desc: "" });
    expect(file).not.toContain("[harness.");
    expect(file).toContain(COPY.placeholder);
  });
});

describe("readDefinition", () => {
  it("says which line does not parse (negative)", () => {
    const reading = readDefinition('slug = "a"\ntools = [\n');
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.line).toBeGreaterThan(0);
  });

  it("reads a file with no slug or tier as nulls", () => {
    expect(readDefinition("tools = []\n")).toEqual({
      ok: true,
      slug: null,
      tier: null,
      tools: 0,
      denied: 0,
    });
  });
});

describe("parks", () => {
  it("parks an irreversible tool and a high or critical one", () => {
    expect(parks(TOOL)).toBe(false);
    expect(parks({ ...TOOL, sideEffect: "irreversible" })).toBe(true);
    expect(parks({ ...TOOL, riskGrade: "high" })).toBe(true);
    expect(parks({ ...TOOL, riskGrade: "critical" })).toBe(true);
  });

  it("does not park an unclassified low-risk tool", () => {
    expect(parks({ ...TOOL, sideEffect: null, riskGrade: "low" })).toBe(false);
  });
});
