import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  invoke: vi.fn(),
  listCapabilities: vi.fn(),
  getSurfaces: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  // Funding is resolved before the model call (ADR-053 §3); an org with no
  // stored key is platform-funded, which is what these fixtures exercise.
  resolveModelFundingSource: async () => ({ fundedBy: "platform" }),
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
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
import { AGENT_AUTHORING_SYSTEM_PROMPT } from "./agent-suggest-core";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

// ADR-043: a governed agent definition grants exactly two kinds of tool.
type ToolFixture = {
  type: "function" | "mcp_server";
  ref: string;
};

const MEMORY_POLICY = {
  halfLifeLowDays: 30,
  halfLifeHighDays: 90,
  recallThreshold: 0.1,
  complianceThreshold: 70,
  defaultDecayFloor: 5,
};

function baseSynthesis() {
  return {
    slug: "deal-scanner",
    name: "Deal Scanner",
    description: "Scans deals for risk.",
    instructions: "Inspect each deal, flag risk, never edit without approval.",
    graph: {
      ontologyId: "sales",
      mode: "read" as "read" | "extend",
      retrieval: {
        strategy: "hybrid" as "semantic" | "lexical" | "hybrid" | "explicit",
        scopeToTypes: ["Deal"] as string[] | undefined,
      },
      budget: {
        maxHops: 2,
        maxNodes: 40,
        minRelevance: 0.5 as number | undefined,
      },
    },
    agentTools: [{ type: "function", ref: "graph.query" }] as ToolFixture[],
    rationale: "A read-only scanner needs graph access.",
  };
}

/** Default candidate world: one ontology, one function cap, one registered MCP
 *  server, one active agent already named "existing-agent", and a memory policy. */
function setupWorld(opts: { schemas?: unknown[] } = {}) {
  const schemas = opts.schemas ?? [
    { schemaName: "sales", displayName: "Sales", enabled: true },
  ];

  mocks.invoke.mockImplementation(async (cap: string) => {
    switch (cap) {
      case "list_schemas":
        return { schemas };
      case "get_memory_policy":
        return MEMORY_POLICY;
      case "browse_plugin_catalog":
        // Catalog MCP servers not registered in this workspace (the local server
        // "GitHub"/mcp_srv1 is a differently-named label, so neither is excluded).
        return {
          servers: [
            {
              name: "github/github-mcp-server",
              title: "GitHub",
              description: "Read repository metadata and pull-request state.",
              installed: false,
            },
            {
              name: "supabase/supabase-mcp",
              title: "Supabase",
              description:
                "Query Supabase Postgres databases and inspect schemas.",
              installed: false,
            },
          ],
          nextOffset: null,
          total: 2,
        };
      case "list_mcp_servers":
        return { servers: [{ publicId: "mcp_srv1", name: "GitHub" }] };
      case "list_agent_defs":
        return {
          agents: [
            {
              slug: "existing-agent",
              description: "already here",
              status: "active",
            },
          ],
        };
      default:
        return {};
    }
  });

  // Agent-surface capability catalog: one usable function, plus the suggest
  // capability itself (which the handler must exclude from candidates).
  mocks.listCapabilities.mockReturnValue([
    { name: "graph.query", description: "Query the knowledge graph" },
    { name: "suggest_agent_def", description: "self — must be excluded" },
  ]);
  mocks.getSurfaces.mockReturnValue(["agent"]);
}

const INPUT = {
  description: "Scan every new deal and flag the risky ones for review.",
};

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
    expect(result.suggestion.config.graph.ontologyId).toBe("sales");
    expect(result.suggestion.config.instructions).toContain(
      "Inspect each deal",
    );
    expect(result.suggestion.config.agentTools).toHaveLength(1);
    expect(result.rationale).toContain("read-only scanner");
    expect(result.warnings).toEqual([]);
    // Output must satisfy the real contract (config feeds agent.definition.create).
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  it("always reports agentType 'custom' — ADR-043 removed code mode", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.agentType).toBe("custom");
  });

  it("passes temperature 0.3 and tenant telemetry, with the authoring prompt + candidates in the system prompt", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      temperature: number;
      system: string;
      prompt: string;
      telemetry: {
        orgId: string;
        workspaceId: string;
        surface: string;
        messageId: string | null;
      };
    };
    expect(call.temperature).toBe(0.3);
    expect(call.system).toContain(AGENT_AUTHORING_SYSTEM_PROMPT);
    expect(call.system).toContain("ONTOLOGY CANDIDATES");
    expect(call.system).toContain("sales");
    expect(call.system).toContain("graph.query");
    // The suggest capability itself must never be offered as a function ref.
    expect(call.system).not.toContain("suggest_agent_def:");
    expect(call.prompt).toContain(INPUT.description);
    expect(call.telemetry.orgId).toBe(TEST_CTX.orgId);
    expect(call.telemetry.workspaceId).toBe(TEST_CTX.workspaceId);
    expect(call.telemetry.messageId).toBeNull();
  });

  it("never shows the model the excised runtime vocabulary", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    const { system } = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    // No candidate section (and no authoring instruction) may offer a kind of
    // tool the platform can no longer govern.
    expect(system).not.toContain("SKILL CANDIDATES");
    expect(system).not.toContain("SUBAGENT CANDIDATES");
    expect(system).not.toContain("DISABLED WORKSPACE SKILLS");
    expect(system).not.toMatch(/agentTools of type 'skill'/);
    expect(system).not.toMatch(/agentTools of type 'agent'/);
  });

  it("grounds the prompt in the inherited workspace memory policy", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    const { system } = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(system).toContain("INHERITED MEMORY POLICY");
    expect(system).toContain("observation half-life: 30 days");
    expect(system).toContain("rule half-life: 90 days");
  });

  it("renders the memory-policy section as unavailable when the read fails", async () => {
    setupWorld();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(
      async (cap: string, input: unknown, ctx: unknown) => {
        if (cap === "get_memory_policy") throw new Error("policy read failed");
        return base(cap, input, ctx);
      },
    );
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    const { system } = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(system).toContain("INHERITED MEMORY POLICY");
    expect(system).toContain("(none available)");
    // The suggestion still lands — one failed source never fails the whole call.
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  // ── deterministic repair ────────────────────────────────────────────────────

  it("drops agentTools whose ref is not a workspace candidate, one warning each", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.agentTools = [
      { type: "function", ref: "graph.query" }, // kept
      { type: "function", ref: "nope.cap" }, // dropped
      { type: "mcp_server", ref: "ghost-server" }, // dropped
      { type: "mcp_server", ref: "mcp_srv1" }, // kept
    ];
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    const refs = result.suggestion.config.agentTools.map((t) => t.ref);
    expect(refs).toEqual(["graph.query", "mcp_srv1"]);
    expect(result.warnings.some((w) => w.includes("nope.cap"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("ghost-server"))).toBe(true);
  });

  it("substitutes an out-of-workspace ontologyId with the first candidate and warns", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.graph.ontologyId = "does-not-exist";
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.config.graph.ontologyId).toBe("sales");
    expect(result.warnings.some((w) => w.includes("does-not-exist"))).toBe(
      true,
    );
  });

  it("leaves the ontology unbound (empty) when the workspace has no graph schema", async () => {
    setupWorld({ schemas: [] });
    const synth = baseSynthesis();
    synth.graph.ontologyId = "sales";
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.config.graph.ontologyId).toBe("");
    expect(
      result.warnings.some((w) => w.toLowerCase().includes("unbound")),
    ).toBe(true);
  });

  it("de-conflicts a slug that collides with an existing agent", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.slug = "existing-agent";
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.slug).toBe("existing-agent-2");
    expect(result.warnings.some((w) => w.includes("existing-agent"))).toBe(
      true,
    );
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

  // ── candidate-source failure tolerance ──────────────────────────────────────

  it("degrades gracefully when one candidate source fails, keeping the others", async () => {
    setupWorld();
    const base = mocks.invoke.getMockImplementation()!;
    // list_schemas is unavailable; every other read keeps working.
    mocks.invoke.mockImplementation(
      async (cap: string, input: unknown, ctx: unknown) => {
        if (cap === "list_schemas") throw new Error("clickhouse is on fire");
        return base(cap, input, ctx);
      },
    );
    const synth = baseSynthesis();
    synth.agentTools = [
      { type: "function", ref: "graph.query" },
      { type: "mcp_server", ref: "mcp_srv1" },
    ];
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    // Ontology candidates fell back to empty → the model's id can't bind.
    expect(result.suggestion.config.graph.ontologyId).toBe("");
    expect(result.warnings.some((w) => w.includes("no graph schema"))).toBe(
      true,
    );
    // The other candidate sources still ground the suggestion.
    expect(result.suggestion.config.agentTools).toContainEqual({
      type: "mcp_server",
      ref: "mcp_srv1",
    });
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(call.system).toContain("mcp_srv1");
    // Still a contract-valid, create-shaped suggestion.
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  // ── catalog-aware recommendations ───────────────────────────────────────────

  it("lists connectable catalog servers in the system prompt, fenced from agentTools", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(call.system).toContain("CONNECTABLE");
    expect(call.system).toContain("github/github-mcp-server");
    expect(call.system).toContain("supabase/supabase-mcp");
    // A connectable server must never appear among the equipable MCP candidates.
    const equipable = call.system.slice(
      call.system.indexOf("MCP SERVER CANDIDATES"),
      call.system.indexOf("INHERITED MEMORY POLICY"),
    );
    expect(equipable).not.toContain("github/github-mcp-server");
  });

  it("passes through recommendations whose refs are in the connectable catalog", async () => {
    setupWorld();
    const synth = {
      ...baseSynthesis(),
      recommendations: [
        {
          ref: "github/github-mcp-server",
          name: "GitHub",
          reason: "answers questions about open PRs — needs GitHub access.",
        },
        {
          ref: "supabase/supabase-mcp",
          name: "Supabase",
          reason: "validates the schema against the Supabase databases.",
        },
      ],
    };
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.recommendations).toEqual([
      {
        kind: "mcp_server",
        ref: "github/github-mcp-server",
        name: "GitHub",
        reason: "answers questions about open PRs — needs GitHub access.",
      },
      {
        kind: "mcp_server",
        ref: "supabase/supabase-mcp",
        name: "Supabase",
        reason: "validates the schema against the Supabase databases.",
      },
    ]);
    // Recommendations never leak into the equipable tool set.
    const toolRefs = result.suggestion.config.agentTools.map((t) => t.ref);
    expect(toolRefs).not.toContain("github/github-mcp-server");
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  it("drops a recommendation whose ref is in neither list, with a warning", async () => {
    setupWorld();
    const synth = {
      ...baseSynthesis(),
      recommendations: [
        {
          ref: "made-up/ghost-mcp",
          name: "Ghost",
          reason: "invented by the model.",
        },
      ],
    };
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.recommendations).toEqual([]);
    expect(result.warnings.some((w) => w.includes("made-up/ghost-mcp"))).toBe(
      true,
    );
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  it("moves an already-registered MCP server out of recommendations into agentTools with a warning", async () => {
    setupWorld();
    const synth = {
      ...baseSynthesis(),
      // The model wrongly recommends a server that is already registered (mcp_srv1).
      recommendations: [
        {
          ref: "mcp_srv1",
          name: "GitHub",
          reason: "already registered — belongs in agentTools.",
        },
      ],
    };
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.recommendations).toEqual([]);
    expect(result.suggestion.config.agentTools).toContainEqual({
      type: "mcp_server",
      ref: "mcp_srv1",
    });
    expect(result.warnings.some((w) => w.includes("already registered"))).toBe(
      true,
    );
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  it("de-duplicates a recommendation the model repeats", async () => {
    setupWorld();
    const rec = {
      ref: "github/github-mcp-server",
      name: "GitHub",
      reason: "needs GitHub access.",
    };
    mocks.generateObjectFor.mockResolvedValue({
      object: { ...baseSynthesis(), recommendations: [rec, { ...rec }] },
    });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.recommendations).toHaveLength(1);
  });

  it("degrades to empty recommendations when the catalog source fails", async () => {
    setupWorld();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(
      async (cap: string, input: unknown, ctx: unknown) => {
        if (cap === "browse_plugin_catalog")
          throw new Error("registry unreachable");
        return base(cap, input, ctx);
      },
    );
    const synth = {
      ...baseSynthesis(),
      recommendations: [
        {
          ref: "github/github-mcp-server",
          name: "GitHub",
          reason: "needs GitHub access.",
        },
      ],
    };
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    // Catalog unreachable → the recommendation can't be validated → dropped.
    expect(result.recommendations).toEqual([]);
    expect(
      result.warnings.some((w) => w.includes("github/github-mcp-server")),
    ).toBe(true);
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  // ── slug budget ─────────────────────────────────────────────────────────────

  it("clamps a >18-char model slug to the budget and de-conflicts within it", async () => {
    setupWorld();
    // 25-char slug; clamps to "audit-schema-addit" (18). Seed that clamped value
    // as an existing agent so the de-conflict must ALSO stay within 18 chars.
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(
      async (cap: string, input: unknown, ctx: unknown) => {
        if (cap === "list_agent_defs") {
          return {
            agents: [
              {
                slug: "audit-schema-addit",
                description: "collision",
                status: "active",
              },
            ],
          };
        }
        return base(cap, input, ctx);
      },
    );
    const synth = { ...baseSynthesis(), slug: "audit-schema-additions-pr" };
    expect(synth.slug.length).toBe(25);
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestion.slug.length).toBeLessThanOrEqual(18);
    expect(result.suggestion.slug).not.toBe("audit-schema-addit"); // de-conflicted
    expect(result.warnings.some((w) => w.includes("budget"))).toBe(true);
    // Still a contract-valid suggestion (slug .max(18) holds).
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  // ── error paths ─────────────────────────────────────────────────────────────

  it("throws a typed AgentSuggestError when the model call fails", async () => {
    setupWorld();
    mocks.generateObjectFor.mockRejectedValue(new Error("gateway down"));

    await expect(
      agentDefinitionSuggestHandler(INPUT, TEST_CTX),
    ).rejects.toBeInstanceOf(AgentSuggestError);
    await expect(
      agentDefinitionSuggestHandler(INPUT, TEST_CTX),
    ).rejects.toThrow(/gateway down/);
  });

  it("throws AgentSuggestError when the synthesis fails final config validation", async () => {
    setupWorld();
    const synth = baseSynthesis();
    // maxNodes must be a positive integer — the real schema rejects 0.
    synth.graph.budget.maxNodes = 0;
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    await expect(
      agentDefinitionSuggestHandler(INPUT, TEST_CTX),
    ).rejects.toBeInstanceOf(AgentSuggestError);
  });

  it("throws when workspaceId is missing from context", async () => {
    setupWorld();
    const noWsCtx = makeCTX({ workspaceId: undefined as unknown as string });

    await expect(agentDefinitionSuggestHandler(INPUT, noWsCtx)).rejects.toThrow(
      /workspaceId is required/,
    );
  });

  // ── suggested role (Agent RBAC Phase 5b) ────────────────────────────────────
  //
  // The narrowest-adequate mapping itself is exhaustively covered in
  // lib/agent-role-suggest.test.ts; these assert the HANDLER wiring — that the
  // suggestion is computed off the REPAIRED config (not the raw synthesis) and
  // survives the contract's output schema.

  it("returns a suggestedRole computed from the repaired config", async () => {
    setupWorld();
    mocks.listCapabilities.mockReturnValue([
      {
        name: "graph.query",
        description: "Query the knowledge graph",
        agent: { category: "graph", riskLevel: "low" },
      },
    ]);
    // baseSynthesis equips graph.query (read-like) with graph mode read ⇒
    // read/answer only.
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestedRole?.roleName).toBe("Agent Observer");
    expect(result.suggestedRole?.reason.length).toBeGreaterThan(0);
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  it("escalates the suggested role when the draft mutates", async () => {
    setupWorld();
    mocks.listCapabilities.mockReturnValue([
      {
        name: "graph.query",
        description: "Mutating capability under a non-read category",
        agent: { category: "write", riskLevel: "low" },
      },
    ]);
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestedRole?.roleName).toBe("Agent Contributor");
  });

  it("computes the role from tools alone — stray trigger data never changes it", async () => {
    // Agent definitions are trigger-free: a definition never carries an
    // attended/unattended signal. A high-risk destructive capability under the
    // attended default lands at Contributor (a human is assumed present to
    // answer its approval prompts). Any stray `triggers` field left in the raw
    // synthesis must NOT feed the suggestion.
    setupWorld();
    mocks.listCapabilities.mockReturnValue([
      {
        name: "graph.query",
        description: "High-risk, non-carve-out",
        agent: { category: "destructive", riskLevel: "high" },
      },
    ]);
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        ...baseSynthesis(),
        // A schedule trigger would once have escalated this to Operator; it must
        // now be ignored entirely.
        triggers: [{ type: "schedule", schedule: "0 * * * *" }],
      },
    });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.suggestedRole?.roleName).toBe("Agent Contributor");
    expect(result.suggestedRole?.reason).not.toMatch(/unattended/i);
  });

  it("computes the role from the REPAIRED tools — a dropped hallucinated ref never escalates it", async () => {
    setupWorld();
    mocks.listCapabilities.mockReturnValue([
      {
        name: "graph.query",
        description: "Query the knowledge graph",
        agent: { category: "graph", riskLevel: "low" },
      },
    ]);
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        ...baseSynthesis(),
        agentTools: [
          { type: "function", ref: "graph.query" },
          // Not in the candidate world ⇒ repairSynthesis drops it with a warning.
          { type: "mcp_server", ref: "hallucinated-server" },
        ] as ToolFixture[],
      },
    });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.warnings.some((w) => w.includes("hallucinated-server"))).toBe(
      true,
    );
    // Had the dropped MCP server counted, this would have been Contributor.
    expect(result.suggestedRole?.roleName).toBe("Agent Observer");
  });

  // ── contract input validation ───────────────────────────────────────────────

  it("rejects a description shorter than the contract minimum", () => {
    expect(() =>
      agentDefinitionSuggest.input.parse({ description: "too short" }),
    ).toThrow();
    expect(() =>
      agentDefinitionSuggest.input.parse({ description: INPUT.description }),
    ).not.toThrow();
  });

  it("rejects a non-kebab nameHint at the contract boundary", () => {
    expect(() =>
      agentDefinitionSuggest.input.parse({
        description: INPUT.description,
        nameHint: "Not Kebab",
      }),
    ).toThrow();
  });
});
