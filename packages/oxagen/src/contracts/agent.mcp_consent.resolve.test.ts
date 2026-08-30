import { describe, expect, it } from "vitest";
import { agentMcpConsentResolve } from "./agent.mcp_consent.resolve";
import { getCapability } from "../registry";

describe("agent.mcp.consent.resolve capability", () => {
  it("parses a valid granted decision", () => {
    const parsed = agentMcpConsentResolve.input.parse({
      approvalId: "apr_abc",
      decision: "granted",
    });
    expect(parsed.decision).toBe("granted");
    expect(parsed.grantAllTools).toBeUndefined();
  });

  it("parses a wildcard pre-grant request", () => {
    const parsed = agentMcpConsentResolve.input.parse({
      approvalId: "apr_abc",
      decision: "granted",
      grantAllTools: true,
    });
    expect(parsed.grantAllTools).toBe(true);
  });

  it("rejects an unknown decision", () => {
    expect(() =>
      agentMcpConsentResolve.input.parse({
        approvalId: "apr_abc",
        decision: "maybe",
      }),
    ).toThrow();
  });

  it("parses a valid output and rejects an unknown resolution", () => {
    expect(
      agentMcpConsentResolve.output.parse({
        approvalId: "apr_abc",
        resolution: "granted",
      }).resolution,
    ).toBe("granted");
    expect(() =>
      agentMcpConsentResolve.output.parse({
        approvalId: "apr_abc",
        resolution: "approved",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("resolve_mcp_consent")).toBe(agentMcpConsentResolve);
  });
});
