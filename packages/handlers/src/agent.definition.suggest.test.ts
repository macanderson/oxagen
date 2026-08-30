import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  invoke: vi.fn(),
  createBuiltinSkillRegistry: vi.fn(),
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
  createBuiltinSkillRegistry: mocks.createBuiltinSkillRegistry,
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
      budget: {
        maxHops: 2,
        maxNodes: 40,
        minRelevance: 0.5 as number | undefined,
      },
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
  const schemas = opts.schemas ?? [
    { schemaName: "sales", displayName: "Sales", enabled: true },
  ];

  mocks.invoke.mockImplementation(async (cap: string) => {
    switch (cap) {
      case "load_skill":
        return { loaded: skillLoaded, body: skillLoaded ? SKILL_BODY : "" };
      case "list_schemas":
        return { schemas };
      case "list_agent_skills":
        return {
          skills: [
            {
              slug: "summarization",
              name: "Summarise Text",
              description: "Summarise text",
            },
            {
              slug: "deep-review",
              name: "Deep Review",
              description: "Deep code review",
            },
          ],
        };
      case "list_workspace_skills":
        // Same two skills, now with their enabled flag: "deep-review" is disabled,
        // so it is a recommendation candidate, not an equipable one.
        return {
          skills: [
            {
              id: "sk_summ",
              name: "Summarise Text",
              description: "Summarise text",
              enabled: true,
            },
            {
              id: "sk_review",
              name: "Deep Review",
              description: "Deep code review",
              enabled: false,
            },
          ],
        };
      case "browse_plugin_catalog":
        // Catalog MCP servers not registered in this workspace (the local server
        // "GitHub"/mcp_srv1 is a differently-named label, so neither is excluded).
        return {
          servers: [
            {
              name: "github/github-mcp-server",
              title: "GitHub",
              description: "Watch PRs, read repo files, open pull requests.",
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

  mocks.registryGet.mockResolvedValue({ body: "# builtin create-agent body" });
  mocks.createBuiltinSkillRegistry.mockReturnValue({ get: mocks.registryGet });

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
    expect(result.suggestion.agentType).toBe("custom");
    expect(result.suggestion.config.graph.ontologyId).toBe("sales");
    expect(result.suggestion.config.instructions).toContain(
      "Inspect each deal",
    );
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
      telemetry: {
        orgId: string;
        workspaceId: string;
        surface: string;
        messageId: string | null;
      };
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
    mocks.invoke.mockImplementation(
      async (cap: string, input: unknown, ctx: unknown) => {
        if (cap === "list_schemas") throw new Error("clickhouse is on fire");
        return base(cap, input, ctx);
      },
    );
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    // Ontology candidates fell back to empty → the model's id can't bind.
    expect(result.suggestion.config.graph.ontologyId).toBe("");
    expect(result.warnings.some((w) => w.includes("no graph schema"))).toBe(
      true,
    );
    // The other candidate sources still ground the suggestion.
    expect(result.suggestion.config.agentTools).toContainEqual({
      type: "skill",
      ref: "summarization",
    });
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(call.system).toContain("summarization");
    // Still a contract-valid, create-shaped suggestion.
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  // ── catalog-aware recommendations ───────────────────────────────────────────

  it("lists connectable catalog servers + disabled skills in the system prompt, fenced from agentTools", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(call.system).toContain("CONNECTABLE");
    expect(call.system).toContain("github/github-mcp-server");
    expect(call.system).toContain("supabase/supabase-mcp");
    // The disabled skill is offered for recommendation, not for equipping.
    expect(call.system).toContain("DISABLED WORKSPACE SKILLS");
    expect(call.system).toContain("deep-review");
    // And it must NOT appear among the equipable SKILL CANDIDATES.
    const skillSection = call.system.slice(
      call.system.indexOf("SKILL CANDIDATES"),
      call.system.indexOf("MCP SERVER CANDIDATES"),
    );
    expect(skillSection).not.toContain("deep-review");
  });

  it("passes through recommendations whose refs are in the catalog / disabled-skill lists", async () => {
    setupWorld();
    const synth = {
      ...baseSynthesis(),
      recommendations: [
        {
          kind: "mcp_server" as const,
          ref: "github/github-mcp-server",
          name: "GitHub",
          reason: "watches PRs for schema changes — needs GitHub access.",
        },
        {
          kind: "mcp_server" as const,
          ref: "supabase/supabase-mcp",
          name: "Supabase",
          reason: "validates the schema against the Supabase databases.",
        },
        {
          kind: "skill" as const,
          ref: "deep-review",
          name: "Deep Review",
          reason: "reviews the schema change carefully before flagging it.",
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
        reason: "watches PRs for schema changes — needs GitHub access.",
      },
      {
        kind: "mcp_server",
        ref: "supabase/supabase-mcp",
        name: "Supabase",
        reason: "validates the schema against the Supabase databases.",
      },
      {
        kind: "skill",
        ref: "deep-review",
        name: "Deep Review",
        reason: "reviews the schema change carefully before flagging it.",
      },
    ]);
    // Recommendations never leak into the equipable tool set.
    const toolRefs = result.suggestion.config.agentTools.map((t) => t.ref);
    expect(toolRefs).not.toContain("github/github-mcp-server");
    expect(toolRefs).not.toContain("deep-review");
    expect(() => agentDefinitionSuggest.output.parse(result)).not.toThrow();
  });

  it("drops recommendations whose ref is in neither connectable list, with a warning each", async () => {
    setupWorld();
    const synth = {
      ...baseSynthesis(),
      recommendations: [
        {
          kind: "mcp_server" as const,
          ref: "made-up/ghost-mcp",
          name: "Ghost",
          reason: "invented by the model.",
        },
        {
          kind: "skill" as const,
          ref: "nonexistent-skill",
          name: "Nope",
          reason: "not a real disabled skill.",
        },
      ],
    };
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const result = await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(result.recommendations).toEqual([]);
    expect(result.warnings.some((w) => w.includes("made-up/ghost-mcp"))).toBe(
      true,
    );
    expect(result.warnings.some((w) => w.includes("nonexistent-skill"))).toBe(
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
          kind: "mcp_server" as const,
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
          kind: "mcp_server" as const,
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

  // ── skill loading ───────────────────────────────────────────────────────────

  it("falls back to the embedded builtin skill when no tenant copy is loaded", async () => {
    setupWorld({ skillLoaded: false });
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionSuggestHandler(INPUT, TEST_CTX);

    expect(mocks.createBuiltinSkillRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.registryGet).toHaveBeenCalledWith("create-agent");
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      system: string;
    };
    expect(call.system).toContain("builtin create-agent body");
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

  it("throws AgentSuggestError when the create-agent skill is unavailable entirely", async () => {
    setupWorld({ skillLoaded: false });
    mocks.registryGet.mockResolvedValue(undefined);
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await expect(
      agentDefinitionSuggestHandler(INPUT, TEST_CTX),
    ).rejects.toBeInstanceOf(AgentSuggestError);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
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
    // baseSynthesis equips graph.query (read-like) + a skill, graph mode read,
    // manual trigger only ⇒ read/answer only.
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
    // Agent definitions are trigger-free: triggering lives in the automations
    // subsystem, so the definition never carries an attended/unattended
    // signal. A high-risk destructive capability under the
    // attended default lands at Contributor (a human is assumed present to
    // answer its approval prompts). Any stray `triggers` field left in the raw
    // synthesis must NOT feed the suggestion — this guards against config.triggers
    // sneaking back into the role computation.
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
        triggers: [
          { type: "schedule", schedule: "0 * * * *" },
        ] as TriggerFixture[],
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
