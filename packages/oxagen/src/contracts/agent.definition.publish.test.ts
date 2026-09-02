import { describe, expect, it } from "vitest";
import { agentDefinitionPublish } from "./agent.definition.publish";
import { getCapability } from "../registry";

describe("agent.definition.publish capability", () => {
  it("parses input with only agentId (version optional)", () => {
    const parsed = agentDefinitionPublish.input.parse({ agentId: "agt_1" });
    expect(parsed.agentId).toBe("agt_1");
    expect(parsed.version).toBeUndefined();
  });

  it("accepts an explicit version", () => {
    const parsed = agentDefinitionPublish.input.parse({
      agentId: "agt_1",
      version: 3,
    });
    expect(parsed.version).toBe(3);
  });

  it("rejects a non-positive version", () => {
    expect(() =>
      agentDefinitionPublish.input.parse({ agentId: "agt_1", version: 0 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentDefinitionPublish.output.parse({
      agentId: "agt_1",
      version: 1,
      checksum: "abc",
      activeVersionId: "ver_1",
    });
    expect(out.checksum).toBe("abc");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("publish_agent_def")).toBe(agentDefinitionPublish);
  });
});
