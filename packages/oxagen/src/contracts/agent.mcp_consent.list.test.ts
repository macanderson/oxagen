import { describe, expect, it } from "vitest";
import { agentMcpConsentList } from "./agent.mcp_consent.list";
import { getCapability } from "../registry";

describe("agent.mcp.consent.list capability", () => {
  it("parses empty input and a mineOnly flag", () => {
    expect(agentMcpConsentList.input.parse({}).mineOnly).toBeUndefined();
    expect(agentMcpConsentList.input.parse({ mineOnly: true }).mineOnly).toBe(
      true,
    );
  });

  it("parses a valid output row", () => {
    const parsed = agentMcpConsentList.output.parse({
      consents: [
        {
          publicId: "mcons_1",
          userId: "u_1",
          mcpServerId: "srv_1",
          toolName: "list_prs",
          status: "granted",
          grantedAt: "2026-06-19T00:00:00.000Z",
          deniedAt: null,
          expiresAt: null,
        },
      ],
    });
    expect(parsed.consents).toHaveLength(1);
    expect(parsed.consents[0]!.status).toBe("granted");
  });

  it("rejects an unknown consent status", () => {
    expect(() =>
      agentMcpConsentList.output.parse({
        consents: [
          {
            publicId: "mcons_1",
            userId: "u_1",
            mcpServerId: "srv_1",
            toolName: "*",
            status: "pending",
            grantedAt: null,
            deniedAt: null,
            expiresAt: null,
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_mcp_consents")).toBe(agentMcpConsentList);
  });
});
