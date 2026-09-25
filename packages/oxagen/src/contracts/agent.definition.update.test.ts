import { describe, expect, it } from "vitest";
import { agentDefinitionUpdate } from "./agent.definition.update";
import { getCapability } from "../registry";

const VALID_CONFIG = {
  graph: {
    ontologyId: "ont_1",
    retrieval: { strategy: "semantic" },
    budget: { maxHops: 1, maxNodes: 10 },
  },
  agentTools: [],
};

describe("agent.definition.update capability", () => {
  it("parses input with only required fields", () => {
    const parsed = agentDefinitionUpdate.input.parse({
      agentId: "agt_1",
      config: VALID_CONFIG,
    });
    expect(parsed.agentId).toBe("agt_1");
    expect(parsed.config.agentTools).toEqual([]);
  });

  it("accepts optional name and description", () => {
    const parsed = agentDefinitionUpdate.input.parse({
      agentId: "agt_1",
      name: "New name",
      description: "New desc",
      config: VALID_CONFIG,
    });
    expect(parsed.name).toBe("New name");
    expect(parsed.description).toBe("New desc");
  });

  it("rejects missing config", () => {
    expect(() =>
      agentDefinitionUpdate.input.parse({ agentId: "agt_1" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentDefinitionUpdate.output.parse({
      agentId: "agt_1",
      version: 2,
      isPublished: false,
    });
    expect(out.version).toBe(2);
    expect(out.isPublished).toBe(false);
  });

  it("keeps a caller's config.budget through the parse (#3743)", () => {
    const parsed = agentDefinitionUpdate.input.parse({
      agentId: "agt_1",
      config: {
        ...VALID_CONFIG,
        budget: { per_day_micros: 10_000_000, mode: "enforced" },
      },
    });
    expect(parsed.config.budget).toEqual({
      per_day_micros: 10_000_000,
      mode: "enforced",
    });
  });

  it("rejects a budget ceiling above the safe integer range", () => {
    expect(() =>
      agentDefinitionUpdate.input.parse({
        agentId: "agt_1",
        config: {
          ...VALID_CONFIG,
          budget: { per_day_micros: Number.MAX_SAFE_INTEGER + 1 },
        },
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("update_agent_def")).toBe(agentDefinitionUpdate);
  });
});
