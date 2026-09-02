import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The revise handler reuses agent-suggest-core (candidate assembly + repair) and
// composes get_agent_def -> generateObjectFor -> update_agent_def, all through
// the same mocked seams as agent.definition.suggest.
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  invoke: vi.fn(),
  createBuiltinSkillRegistry: vi.fn(),
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

vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: mocks.listCapabilities,
  getSurfaces: mocks.getSurfaces,
}));

import {
  agentDefinitionReviseHandler,
  AgentReviseError,
} from "./agent.definition.revise";
import { AgentSuggestError } from "./agent-suggest-core";
import { TEST_CTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const SKILL_BODY = "# Synthesising an agent configuration\n\nFill the config.";

const CURRENT_AGENT = {
  agentId: "uuid-agent-1",
  publicId: "agt_DEAL01",
  slug: "deal-scanner",
  agentKey: "acme.sales.deal-scanner",
  name: "Deal Scanner",
  description: "Scans deals for risk.",
  avatarUrl: null,
  summary: null,
  agentType: "custom",
  status: "active",
  deploymentStatus: "inactive",
  version: 1,
  isPublished: true,
  managed: false,
  config: {
    graph: {
      ontologyId: "sales",
      mode: "read",
      retrieval: { strategy: "hybrid" },
      budget: { maxHops: 2, maxNodes: 40 },
    },
    agentTools: [{ type: "function", ref: "graph.query" }],
    triggers: [],
    instructions: "Inspect each deal, flag risk.",
  },
};

/** A complete, valid revise synthesis. The model's `slug` and `name` differ from
 *  the current agent on purpose, to prove the handler pins the slug (never sends
 *  it to update) and forwards the new name. */
function baseSynthesis() {
  return {
    slug: "renamed-scanner",
    name: "Risk Scanner",
    description: "Scans deals for risk and cites the source.",
    agentType: "custom" as "custom" | "code",
    instructions: "Inspect each deal, flag risk, cite the graph node.",
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
    ],
    triggers: [{ type: "manual" as const }],
    changeSummary: [
      "Equipped the summarization skill",
      "Renamed to Risk Scanner",
    ],
    rationale: "Adding a summariser sharpens the risk write-ups.",
  };
}

/** Candidate world: one ontology, one function cap, one skill, no MCP/agents. */
function setupWorld(currentOverrides: Partial<typeof CURRENT_AGENT> = {}) {
  mocks.listCapabilities.mockReturnValue([
    { name: "graph.query", description: "Query the graph" },
  ]);
  mocks.getSurfaces.mockReturnValue(["agent"]);

  mocks.invoke.mockImplementation(async (cap: string) => {
    switch (cap) {
      case "get_agent_def":
        return { ...CURRENT_AGENT, ...currentOverrides };
      case "load_skill":
        return { loaded: true, body: SKILL_BODY };
      case "list_schemas":
        return {
          schemas: [
            { schemaName: "sales", displayName: "Sales", enabled: true },
          ],
        };
      case "list_agent_skills":
        return {
          skills: [
            {
              slug: "summarization",
              name: "Summarise Text",
              description: "Summarise text",
            },
          ],
        };
      case "list_mcp_servers":
        return { servers: [] };
      case "list_agent_defs":
        return {
          agents: [
            {
              slug: "deal-scanner",
              description: "Scans deals",
              status: "active",
            },
          ],
        };
      case "browse_plugin_catalog":
        return { servers: [] };
      case "list_workspace_skills":
        return {
          skills: [
            {
              id: "sk_summ",
              name: "Summarise Text",
              description: "Summarise text",
              enabled: true,
            },
          ],
        };
      case "update_agent_def":
        return { agentId: "agt_DEAL01", version: 2, isPublished: false };
      default:
        return {};
    }
  });
}

describe("agentDefinitionReviseHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const INPUT = {
    agentId: "agt_DEAL01",
    prompt: "Add a summariser and rename it Risk Scanner",
  };

  it("persists a new bumped, unpublished version and returns the change summary", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    const out = await agentDefinitionReviseHandler(INPUT, TEST_CTX);

    expect(out.agentId).toBe("agt_DEAL01");
    expect(out.version).toBe(2);
    expect(out.isPublished).toBe(false);
    expect(out.changeSummary).toEqual([
      "Equipped the summarization skill",
      "Renamed to Risk Scanner",
    ]);
    expect(out.rationale).toBe(
      "Adding a summariser sharpens the risk write-ups.",
    );
  });

  it("composes update_agent_def with the designed config and never sends a slug", async () => {
    setupWorld();
    mocks.generateObjectFor.mockResolvedValue({ object: baseSynthesis() });

    await agentDefinitionReviseHandler(INPUT, TEST_CTX);

    const updateCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "update_agent_def",
    );
    expect(updateCall).toBeDefined();
    const updateInput = updateCall![1] as Record<string, unknown>;
    // Identity change is allowed via name; slug is immutable and must NOT be sent.
    expect(updateInput).not.toHaveProperty("slug");
    expect(updateInput.agentId).toBe("agt_DEAL01");
    expect(updateInput.name).toBe("Risk Scanner");
    expect(updateInput.agentType).toBe("custom");
    const config = updateInput.config as { agentTools: Array<{ ref: string }> };
    expect(config.agentTools.map((t) => t.ref)).toEqual([
      "graph.query",
      "summarization",
    ]);
  });

  it("drops a hallucinated tool ref and reports it as a warning", async () => {
    setupWorld();
    const synth = baseSynthesis();
    synth.agentTools.push({ type: "skill", ref: "does-not-exist" });
    mocks.generateObjectFor.mockResolvedValue({ object: synth });

    const out = await agentDefinitionReviseHandler(INPUT, TEST_CTX);

    expect(out.warnings.some((w) => w.includes("does-not-exist"))).toBe(true);
    const updateCall = mocks.invoke.mock.calls.find(
      (c) => c[0] === "update_agent_def",
    )!;
    const config = (
      updateCall[1] as { config: { agentTools: Array<{ ref: string }> } }
    ).config;
    expect(config.agentTools.map((t) => t.ref)).not.toContain("does-not-exist");
  });

  it("rejects a product-managed agent before any model call", async () => {
    setupWorld({ managed: true });

    await expect(
      agentDefinitionReviseHandler(INPUT, TEST_CTX),
    ).rejects.toBeInstanceOf(AgentReviseError);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "update_agent_def",
      expect.anything(),
      expect.anything(),
    );
  });

  it("wraps a model synthesis failure as AgentSuggestError and never persists", async () => {
    setupWorld();
    mocks.generateObjectFor.mockRejectedValue(new Error("gateway down"));

    await expect(
      agentDefinitionReviseHandler(INPUT, TEST_CTX),
    ).rejects.toBeInstanceOf(AgentSuggestError);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "update_agent_def",
      expect.anything(),
      expect.anything(),
    );
  });
});
