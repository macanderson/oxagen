import { describe, expect, it } from "vitest";
import { agentDeploy } from "./agent.deploy";
import { getCapability } from "../registry";

describe("agent.deploy capability", () => {
  it("parses an activate input", () => {
    const parsed = agentDeploy.input.parse({
      agentId: "agt_1",
      deploymentStatus: "active",
    });
    expect(parsed.deploymentStatus).toBe("active");
  });

  it("parses a deactivate input", () => {
    const parsed = agentDeploy.input.parse({
      agentId: "agt_1",
      deploymentStatus: "inactive",
    });
    expect(parsed.deploymentStatus).toBe("inactive");
  });

  it("rejects an unknown deploymentStatus", () => {
    expect(() =>
      agentDeploy.input.parse({ agentId: "agt_1", deploymentStatus: "paused" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = agentDeploy.output.parse({
      agentId: "agt_1",
      deploymentStatus: "active",
    });
    expect(out.agentId).toBe("agt_1");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("deploy_agent")).toBe(agentDeploy);
  });
});
