import { describe, expect, it } from "vitest";
import { agentEnvironmentList } from "./agent.environment.list";

describe("agent.environment.list contract", () => {
  it("registers with the correct name", () => {
    expect(agentEnvironmentList.name).toBe("list_agent_environments");
  });
  it("requires an agentId", () => {
    expect(() =>
      agentEnvironmentList.input.parse({ agentId: "a_1" }),
    ).not.toThrow();
    expect(() => agentEnvironmentList.input.parse({})).toThrow();
  });
  it("outputs a bindings array (a null template means 'use env default')", () => {
    expect(() =>
      agentEnvironmentList.output.parse({
        bindings: [
          {
            id: "aeb_1",
            agentId: "a_1",
            environmentId: "env_1",
            environmentName: "Production",
            environmentSlug: "production",
            sandboxTemplateId: null,
            sandboxTemplateName: null,
            isPrimary: false,
          },
        ],
      }),
    ).not.toThrow();
  });
});
