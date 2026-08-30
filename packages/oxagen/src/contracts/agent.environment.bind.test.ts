import { describe, expect, it } from "vitest";
import { agentEnvironmentBind } from "./agent.environment.bind";

describe("agent.environment.bind contract", () => {
  it("registers with the correct name and agent domain", () => {
    expect(agentEnvironmentBind.name).toBe("bind_agent_environment");
    expect(agentEnvironmentBind.domain).toBe("agent");
  });
  it("accepts a binding with and without an explicit template", () => {
    expect(() =>
      agentEnvironmentBind.input.parse({
        agentId: "a_1",
        environmentId: "env_1",
      }),
    ).not.toThrow();
    expect(() =>
      agentEnvironmentBind.input.parse({
        agentId: "a_1",
        environmentId: "env_1",
        sandboxTemplateId: "sbx_1",
        isPrimary: true,
      }),
    ).not.toThrow();
    expect(() =>
      agentEnvironmentBind.input.parse({
        agentId: "a_1",
        environmentId: "env_1",
        sandboxTemplateId: null,
      }),
    ).not.toThrow();
  });
  it("requires agentId and environmentId", () => {
    expect(() =>
      agentEnvironmentBind.input.parse({ agentId: "a_1" }),
    ).toThrow();
  });
  it("outputs a binding with resolved names", () => {
    expect(() =>
      agentEnvironmentBind.output.parse({
        binding: {
          id: "aeb_1",
          agentId: "a_1",
          environmentId: "env_1",
          environmentName: "Production",
          environmentSlug: "production",
          sandboxTemplateId: "sbx_1",
          sandboxTemplateName: "SWE-bench",
          isPrimary: true,
        },
      }),
    ).not.toThrow();
  });
});
