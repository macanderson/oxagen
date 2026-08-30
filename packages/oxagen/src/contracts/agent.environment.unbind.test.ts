import { describe, expect, it } from "vitest";
import { agentEnvironmentUnbind } from "./agent.environment.unbind";

describe("agent.environment.unbind contract", () => {
  it("registers with the correct name", () => {
    expect(agentEnvironmentUnbind.name).toBe("unbind_agent_environment");
  });
  it("requires agentId and environmentId", () => {
    expect(() =>
      agentEnvironmentUnbind.input.parse({
        agentId: "a_1",
        environmentId: "env_1",
      }),
    ).not.toThrow();
    expect(() =>
      agentEnvironmentUnbind.input.parse({ agentId: "a_1" }),
    ).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      agentEnvironmentUnbind.output.parse({ ok: true }),
    ).not.toThrow();
  });
});
