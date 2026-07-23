import { describe, expect, it } from "vitest";
import { agentDefinitionCreate } from "./agent.definition.create";
import { getCapability } from "../registry";

const VALID_CONFIG = {
  graph: {
    ontologyId: "ont_1",
    retrieval: { strategy: "hybrid" },
    budget: { maxHops: 2, maxNodes: 20 },
  },
  agentTools: [{ type: "skill", ref: "coding" }],
  instructions: "Be helpful.",
};

describe("agent.definition.create capability", () => {
  it("parses a minimal valid input and applies defaults", () => {
    const parsed = agentDefinitionCreate.input.parse({
      slug: "my-agent",
      name: "My Agent",
      config: VALID_CONFIG,
    });
    expect(parsed.slug).toBe("my-agent");
    expect(parsed.agentType).toBe("custom");
    expect(parsed.config.graph.mode).toBe("read");
    expect(parsed.config.agentTools).toHaveLength(1);
  });

  it("rejects a non-kebab slug", () => {
    expect(() =>
      agentDefinitionCreate.input.parse({
        slug: "Bad Slug",
        name: "x",
        config: VALID_CONFIG,
      }),
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      agentDefinitionCreate.input.parse({
        slug: "ok",
        name: "",
        config: VALID_CONFIG,
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentDefinitionCreate.output.parse({
      agentId: "agt_1",
      publicId: "agt_1",
      slug: "my-agent",
      version: 1,
    });
    expect(out.version).toBe(1);
  });

  it("rejects a non-positive version in output", () => {
    expect(() =>
      agentDefinitionCreate.output.parse({
        agentId: "a",
        publicId: "a",
        slug: "s",
        version: 0,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("create_agent_def")).toBe(agentDefinitionCreate);
  });
});
