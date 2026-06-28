import { describe, expect, it } from "vitest";
import { agentSandboxStart } from "./agent.sandbox.start";
import { getCapability } from "../registry";

describe("agent.sandbox.start capability", () => {
  it("is registered with the durable-session metadata", () => {
    const cap = getCapability("agent.sandbox.start");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("agent");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(expect.arrayContaining(["api", "mcp", "agent"]));
  });

  it("applies durable defaults when only nothing is supplied", () => {
    const parsed = agentSandboxStart.input.parse({});
    expect(parsed.image).toBe("agent");
    expect(parsed.memoryMb).toBe(2048);
    expect(parsed.ttlSeconds).toBe(86_400);
    expect(parsed.idleTimeoutSeconds).toBe(1_200);
    expect(parsed.network).toBe("allow");
  });

  it("accepts each image flavor", () => {
    for (const image of ["node", "python", "shell", "agent"] as const) {
      expect(agentSandboxStart.input.parse({ image }).image).toBe(image);
    }
  });

  it("rejects an unknown image", () => {
    expect(() => agentSandboxStart.input.parse({ image: "ruby" })).toThrow();
  });

  it("caps ttlSeconds at 24h", () => {
    expect(() => agentSandboxStart.input.parse({ ttlSeconds: 90_000 })).toThrow();
    expect(agentSandboxStart.input.parse({ ttlSeconds: 86_400 }).ttlSeconds).toBe(86_400);
  });

  it("rejects an empty sessionKey but accepts a real one", () => {
    expect(() => agentSandboxStart.input.parse({ sessionKey: "" })).toThrow();
    expect(agentSandboxStart.input.parse({ sessionKey: "conv_42" }).sessionKey).toBe("conv_42");
  });

  it("validates the output shape", () => {
    const out = agentSandboxStart.output.parse({
      sessionId: "sbx_abc",
      status: "running",
      image: "agent",
      createdAt: new Date().toISOString(),
      reused: false,
    });
    expect(out.sessionId).toBe("sbx_abc");
    expect(out.reused).toBe(false);
  });
});
