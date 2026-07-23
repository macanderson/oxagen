import { describe, expect, it } from "vitest";
import { agentDefinitionGet } from "./agent.definition.get";
import { getCapability } from "../registry";

describe("agent.definition.get capability", () => {
  it("parses a minimal input", () => {
    const parsed = agentDefinitionGet.input.parse({ agentId: "agt_1" });
    expect(parsed.agentId).toBe("agt_1");
  });

  it("parses a valid output including the config and managed flag", () => {
    const out = agentDefinitionGet.output.parse({
      agentId: "agt_1",
      publicId: "agt_1",
      slug: "qa-chat",
      agentKey: "acme.default.qa-chat",
      name: "QA Chat",
      description: null,
      agentType: "interactive_chat",
      status: "active",
      deploymentStatus: "active",
      version: 1,
      isPublished: true,
      managed: true,
      avatarUrl: null,
      summary: null,
      config: {
        graph: {
          ontologyId: "ont",
          mode: "read",
          retrieval: { strategy: "hybrid" },
          budget: { maxHops: 2, maxNodes: 20 },
        },
        agentTools: [],
      },
    });
    expect(out.status).toBe("active");
    expect(out.config.graph.ontologyId).toBe("ont");
    expect(out.managed).toBe(true);
  });

  it("rejects output missing the managed field", () => {
    expect(() =>
      agentDefinitionGet.output.parse({
        agentId: "a",
        publicId: "a",
        slug: "s",
        agentKey: null,
        name: "n",
        description: null,
        agentType: "custom",
        status: "active",
        deploymentStatus: "active",
        version: 1,
        isPublished: false,
        // managed intentionally omitted
        config: {
          graph: {
            ontologyId: "o",
            retrieval: { strategy: "hybrid" },
            budget: { maxHops: 1, maxNodes: 1 },
          },
          agentTools: [],
        },
      }),
    ).toThrow();
  });

  it("rejects an unknown status in output", () => {
    expect(() =>
      agentDefinitionGet.output.parse({
        agentId: "a",
        publicId: "a",
        slug: "s",
        agentKey: null,
        name: "n",
        description: null,
        agentType: "t",
        status: "paused",
        deploymentStatus: "active",
        version: 1,
        isPublished: true,
        config: {
          graph: {
            ontologyId: "o",
            retrieval: { strategy: "hybrid" },
            budget: { maxHops: 1, maxNodes: 1 },
          },
          agentTools: [],
        },
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_agent_def")).toBe(agentDefinitionGet);
  });
});
