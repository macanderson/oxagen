import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  invoke: vi.fn(),
  createSkillRegistry: vi.fn(),
  registryGet: vi.fn(),
  listCapabilities: vi.fn(),
  getSurfaces: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@oxagen/skills", () => ({
  createSkillRegistry: mocks.createSkillRegistry,
}));

// Only the two runtime helpers the handler pulls from the barrel are stubbed;
// the type-only imports (CapabilityContext/CapabilityHandler) erase at compile,
// and agentDefinitionConfigSchema / the contract come from separate module paths
// so they stay real — the final validation runs the genuine schema.
vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: mocks.listCapabilities,
  getSurfaces: mocks.getSurfaces,
}));

import {
  agentDefinitionSuggestHandler,
  AgentSuggestError,
} from "./agent.definition.suggest";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const SKILL_BODY = "# Synthesising an agent configuration\n\nFill the config.";

type ToolFixture = {
  type: "function" | "mcp_server" | "skill" | "agent";
  ref: string;
};
type TriggerFixture = {
  type: "manual" | "schedule" | "event";
  eventSource?: string;
  eventType?: string;
  schedule?: string;
  filter?: { branches?: string[]; pathGlobs?: string[] };
};

function baseSynthesis() {
  return {
    slug: "deal-scanner",
    name: "Deal Scanner",
    description: "Scans deals for risk.",
    agentType: "custom" as "custom" | "code",
    instructions: "Inspect each deal, flag risk, never edit without approval.",
    graph: {
      ontologyId: "sales",
      mode: "read" as "read" | "extend",
      retrieval: {
        strategy: "hybrid" as "semantic" | "lexical" | "hybrid" | "explicit",
        scopeToTypes: ["Deal"] as string[] | undefined,
      },
      budget: { maxHops: 2, maxNodes: 40, minRelevance: 0.5 as number | undefined },
    },
    agentTools: [
      { type: "function", ref: "graph.query" },
      { type: "skill", ref: "summarization" },
    ] as ToolFixture[],
    triggers: [{ type: "manual" }] as TriggerFixture[],
    rationale: "A read-only scanner needs graph access and a summariser.",
  };
}

/** Default candidate world: one ontology, one function cap, one skill, one MCP
 *  server, one active agent already named "existing-agent". */
function setupWorld(opts: { skillLoaded?: boolean; schemas?: unknown[] } = {}) {
  const skillLoaded = opts.skillLoaded ?? true;
  const schemas =
    opts.schemas ??
    [{ schemaName: "sales", displayName: "Sales", enabled: true }];

  mocks.invoke.mockImplementation(async (cap: string) => {
    switch (cap) {
      case "agent.skill.load":
        return { loaded: skillLoaded, body: skillLoaded ? SKILL_BODY : "" };
      case "schema.list":
        return { schemas };
      case "agent.skill.list":
        return { skills: [{ slug: "summarization", description: "Summarise text" }] };
      case "agent.mcp.list":
        return { servers: [{ publicId: "mcp_srv1", name: "GitHub" }] };
      case "agent.definition.list":
        return {
          agents: [
            { slug: "existing-agent", description: "already here", status: "active" },
          ],
        };
      default:
        return {};
    }
  });

  mocks.registryGet.mockResolvedValue({ body: "# builtin create-agent body" });
  mocks.createSkillRegistry.mockReturnValue({ get: mocks.registryGet });

  // Agent-surface capability catalog: one usable function, plus the suggest
  // capability itself (which the handler must exclude from candidates).
  mocks.listCapabilities.mockReturnValue([
    { name: "graph.query", description: "Query the knowledge graph" },
    { name: "agent.definition.suggest", description: "self — must be excluded" },
  ]);
  mocks.getSurfaces.mockReturnValue(["agent"]);
}

const INPUT = { description: "Scan every new deal and flag the risky ones for review." };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentDefinitionSuggestHandler (@oxagen/handlers)", () => {
  // ── happy path ────────────────────────────────────────────────────────────

  it("returns a create-shaped suggestion with no warnings on a clean synthesis", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.slug).toBe("deal-scanner");
    expect(result.suggestion.name).toBe("Deal Scanner");
    expect(result.suggestion.agentType).toBe("custom");
    expect(result.suggestion.config.graph.ontologyId).toBe("sales");
    expect(result.suggestion.config.instructions).toContain("Inspect each deal");
    expect(result.suggestion.config.agentTools).toHaveLength(2);
    expect(result.rationale).toContain("read-only scanner");
    expect(result.warnings).toEqual([]);
    // Output must satisfy the real contract (config feeds agent.definition.create).
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  it("passes temperature 0.3 and tenant telemetry, with the skill body + candidates in the system prompt", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      temperature: number;
      system: string;
      prompt: string;
      telemetry: { orgId: string; workspaceId: string; surface: string; messageId: string | null };
    };
    expect(call.temperature).toBe(0.3);
    expect(call.system).toContain(SKILL_BODY);
    expect(call.system).toContain("ONTOLOGY CANDIDATES");
    expect(call.system).toContain("sales");
    expect(call.system).toContain("graph.query");
    // The suggest capability itself must never be offered as a function ref.
    expect(call.system).not.toContain("agent.definition.suggest:");
    expect(call.prompt).toContain(INPUT.description);
    expect(call.telemetry.orgId).toBe(TEST_CTX.orgId);
    expect(call.telemetry.workspaceId).toBe(TEST_CTX.workspaceId);
    expect(call.telemetry.messageId).toBeNull();
  });

  // ── deterministic repair ────────────────────────────────────────────────────

  it("drops agentTools whose ref is not a workspace candidate, one warning each", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.agentTools = [
      { type: "function", ref: "graph.query" }, // kept
      { type: "function", ref: "nope.cap" }, // dropped
      { type: "agent", ref: "ghost-agent" }, // dropped (not an active agent)
      { type: "mcp_server", ref: "mcp_srv1" }, // kept
    ];
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    const refs = result.suggestion.config.agentTools.map((t) => t.ref);
    expect(refs).toEqual(["graph.query", "mcp_srv1"]);
    expect(result.warnings.some((w) => w.includes("nope.cap"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("ghost-agent"))).toBe(true);
  });

  it("forces every suggested trigger to enabled:false and drops structurally-invalid ones", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.triggers = [
      { type: "schedule", schedule: "0 9 * * 1" },
      { type: "event", eventSource: "github_repo", eventType: "push" },
      { type: "event" }, // invalid: missing source/type → dropped
      { type: "schedule" }, // invalid: missing cron → dropped
    ];
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.config.triggers).toHaveLength(2);
    for (const t of result.suggestion.config.triggers) {
      expect(t.enabled).toBe(false);
    }
    expect(result.warnings.filter((w) => w.toLowerCase().includes("trigger"))).toHaveLength(2);
  });

  it("substitutes an out-of-workspace ontologyId with the first candidate and warns", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.graph.ontologyId = "does-not-exist";
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.config.graph.ontologyId).toBe("sales");
    expect(result.warnings.some((w) => w.includes("does-not-exist"))).toBe(true);
  });

  it("leaves the ontology unbound (empty) when the workspace has no graph schema", async () => {
    setupWorld({ schemas: [] });
    const synth = baseSynthesis();
    synth.graph.ontologyId = "sales";
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.config.graph.ontologyId).toBe("");
    expect(result.warnings.some((w) => w.toLowerCase().includes("unbound"))).toBe(true);
  });

  it("de-conflicts a slug that collides with an existing agent", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.slug = "existing-agent";
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.slug).toBe("existing-agent-2");
    expect(result.warnings.some((w) => w.includes("existing-agent"))).toBe(true);
  });

  it("honours a kebab nameHint over the model's slug", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(
      { ...INPUT, nameHint: "risk-watcher" },
      TEST_CTX,
    );

    expect(result.suggestion.slug).toBe("risk-watcher");
  });

  it("drops invalid skill and mcp_server refs while keeping valid ones of each type", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.agentTools = [
      { type: "skill", ref: "summarization" }, // valid
      { type: "skill", ref: "nonexistent-skill" }, // invalid → dropped
      { type: "mcp_server", ref: "mcp_srv1" }, // valid
      { type: "mcp_server", ref: "ghost-server" }, // invalid → dropped
    ];
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.config.agentTools).toEqual([
      { type: "skill", ref: "summarization" },
      { type: "mcp_server", ref: "mcp_srv1" },
    ]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("nonexistent-skill");
    expect(result.warnings[1]).toContain("ghost-server");
  });

  it("passes agentType 'code' through the suggestion", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.agentType = "code";
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const coded = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);
    expect(coded.suggestion.agentType).toBe("code");
  });

  // ── candidate-source failure tolerance ──────────────────────────────────────

  it("degrades gracefully when one candidate source fails, keeping the others", async () => {
    setupWorld();
    const base = mocks.invoke.getMockImplementation()!;
    // schema.list is unavailable; every other read keeps working.
    mocks.invoke.mockImplementation(async (cap: string, input: unknown, ctx: unknown) => {
      if (cap === "schema.list") throw new Error("clickhouse is on fire");
      return base(cap, input, ctx);
    });
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    // Ontology candidates fell back to empty → the model's id can't bind.
    expect(result.suggestion.config.graph.ontologyId).toBe("");
    expect(result.warnings.some((w) => w.includes("no graph schema"))).toBe(true);
    // The other candidate sources still ground the suggestion.
    expect(result.suggestion.config.agentTools).toContainEqual({
      type: "skill",
      ref: "summarization",
    });
    const call = mocks.generateObjectFor.mock.calls[0]![0] as { system: string };
    expect(call.system).toContain("summarization");
    // Still a contract-valid, create-shaped suggestion.
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  // ── skill loading ───────────────────────────────────────────────────────────

  it("falls back to the builtin filesystem skill when no tenant copy is loaded", async () => {
    setupWorld({ skillLoaded: false });
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(mocks.createSkillRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.registryGet).toHaveBeenCalledWith("create-agent");
    const call = mocks.generateObjectFor.mock.calls[0]![0] as { system: string };
    expect(call.system).toContain("builtin create-agent body");
  });

  // ── error paths ─────────────────────────────────────────────────────────────

  it("throws a typed AgentSuggestError when the model call fails", async () => {
    setupWorld();
    mocks.generateObjectFor.mockRejectedValue(new Error("gateway down"));

    await expect(agentDefinitionSuggestHandler(INPUT, TEST_CTX)).rejects.toBeInstanceOf(
      AgentSuggestError,
    );
    await expect(agentDefinitionSuggestHandler(INPUT, TEST_CTX)).rejects.toThrow(/gateway down/);
  });

  it("throws AgentSuggestError when the create-agent skill is unavailable entirely", async () => {
    setupWorld({ skillLoaded: false });
    mocks.registryGet.mockResolvedValue(undefined);
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await expect(agentDefinitionSuggestHandler(INPUT, TEST_CTX)).rejects.toBeInstanceOf(
      AgentSuggestError,
    );
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("throws when workspaceId is missing from context", async () => {
    setupWorld();
    const noWsCtx = makeCTX({ workspaceId: undefined as unknown as string });

    await expect(agentDefinitionSuggestHandler(INPUT, noWsCtx)).rejects.toThrow(
      /workspaceId is required/,
    );
  });

  // ── contract input validation ───────────────────────────────────────────────

  it("rejects a description shorter than the contract minimum", () => {
    expect(() => agentDefinitionSuggest.input.parse({ description: "too short" })).toThrow();
    expect(() =>
      agentDefinitionSuggest.input.parse({ description: INPUT.description }),
    ).not.toThrow();
  });

  it("rejects a non-kebab nameHint at the contract boundary", () => {
    expect(() =>
      agentDefinitionSuggest.input.parse({ description: INPUT.description, nameHint: "Not Kebab" }),
    ).toThrow();
  });
});
