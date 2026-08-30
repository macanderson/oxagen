import { describe, expect, it } from "vitest";
import { agentSandboxStop } from "./agent.sandbox.stop";
import { getCapability } from "../registry";

describe("agent.sandbox.stop capability", () => {
  it("is registered and scoped", () => {
    const cap = getCapability("stop_sandbox");
    expect(cap?.domain).toBe("agent");
    expect(cap?.scoped).toBe(true);
  });

  it("requires a sessionId", () => {
    expect(() => agentSandboxStop.input.parse({})).toThrow();
    expect(agentSandboxStop.input.parse({ sessionId: "sbx_1" }).sessionId).toBe(
      "sbx_1",
    );
  });

  it("validates the output shape", () => {
    expect(agentSandboxStop.output.parse({ stopped: true }).stopped).toBe(true);
  });
});
