import { describe, expect, it } from "vitest";
import { agentDefinitionDelete } from "./agent.definition.delete";
import { getCapability } from "../registry";

describe("agent.definition.delete capability", () => {
  it("parses a minimal input", () => {
    const parsed = agentDefinitionDelete.input.parse({ agentId: "agt_1" });
    expect(parsed.agentId).toBe("agt_1");
  });

  it("rejects missing agentId", () => {
    expect(() => agentDefinitionDelete.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentDefinitionDelete.output.parse({
      agentId: "agt_1",
      deleted: true,
    });
    expect(out.deleted).toBe(true);
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("delete_agent_def")).toBe(agentDefinitionDelete);
  });
});
