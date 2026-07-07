import { describe, expect, it } from "vitest";
import { agentDefinitionSuggest } from "./agent.definition.suggest";
import { getCapability } from "../registry";

const VALID_CONFIG = {
  graph: {
    ontologyId: "sales",
    retrieval: { strategy: "hybrid" },
    budget: { maxHops: 2, maxNodes: 20 },
  },
  agentTools: [{ type: "skill", ref: "summarization" }],
  triggers: [{ type: "manual" }],
  instructions: "Scan deals and flag risk.",
};

describe("agent.definition.suggest capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = agentDefinitionSuggest.input.parse({
      description: "Scan every new deal and flag the risky ones for review.",
    });
    expect(parsed.description).toContain("Scan every new deal");
  });

  it("accepts an optional kebab nameHint and agentTypeHint", () => {
    const parsed = agentDefinitionSuggest.input.parse({
      description: "Watch the repo and flag documentation drift on every push.",
      nameHint: "docs-drift-watcher",
      agentTypeHint: "code",
    });
    expect(parsed.nameHint).toBe("docs-drift-watcher");
    expect(parsed.agentTypeHint).toBe("code");
  });

  it("rejects a description shorter than 10 characters", () => {
    expect(() => agentDefinitionSuggest.input.parse({ description: "too short" })).toThrow();
  });

  it("rejects a non-kebab nameHint", () => {
    expect(() =>
      agentDefinitionSuggest.input.parse({
        description: "A valid, sufficiently long description.",
        nameHint: "Not Kebab",
      }),
    ).toThrow();
  });

  it("parses a valid output and applies config defaults", () => {
    const out = agentDefinitionSuggest.output.parse({
      suggestion: {
        slug: "deal-scanner",
        name: "Deal Scanner",
        description: "Scans deals for risk.",
        config: VALID_CONFIG,
      },
      rationale: "A read-only scanner needs graph access and a summariser.",
    });
    // agentType defaults to "custom"; graph.mode defaults to "read"; warnings to [].
    expect(out.suggestion.agentType).toBe("custom");
    expect(out.suggestion.config.graph.mode).toBe("read");
    expect(out.suggestion.config.triggers[0]!.enabled).toBe(false);
    expect(out.warnings).toEqual([]);
  });

  it("rejects an output whose suggestion slug is not kebab-case", () => {
    expect(() =>
      agentDefinitionSuggest.output.parse({
        suggestion: {
          slug: "Not Kebab",
          name: "x",
          description: "y",
          config: VALID_CONFIG,
        },
        rationale: "r",
      }),
    ).toThrow();
  });

  it("requires non-empty instructions in the suggested config", () => {
    expect(() =>
      agentDefinitionSuggest.output.parse({
        suggestion: {
          slug: "deal-scanner",
          name: "Deal Scanner",
          description: "Scans deals.",
          config: { ...VALID_CONFIG, instructions: "" },
        },
        rationale: "r",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.definition.suggest")).toBe(agentDefinitionSuggest);
  });
});
