/**
 * Contract test for list_credential_grants (#2958).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { credentialGrantList } from "./credential.grant.list";

describe("list_credential_grants is registered as declared", () => {
  it("is scoped, mutates=false and is never a governed action", () => {
    const cap = getCapability("list_credential_grants");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
  });
});

describe("list_credential_grants", () => {
  it("defaults the page size and accepts a connection filter", () => {
    expect(credentialGrantList.input.parse({})).toEqual({ limit: 50 });
    expect(
      credentialGrantList.input.parse({ connectionId: "mcrd_1" }).connectionId,
    ).toBe("mcrd_1");
  });

  it("carries a grant's scope without secret material", () => {
    const parsed = credentialGrantList.output.parse({
      items: [
        {
          id: "mcgr_1",
          connectionId: "mcrd_1",
          serverId: "mcs_1",
          serverName: "github",
          runId: null,
          scope: {
            endpointUrl: "https://mcp.github.com/mcp",
            authKind: "oauth",
            downscope: "none",
          },
          providerTokenId: null,
          issuedAt: "2026-09-15T00:00:00.000Z",
          expiresAt: "2026-09-15T01:00:00.000Z",
          revokedAt: null,
          status: "active",
        },
      ],
      nextCursor: null,
    });
    expect(Object.keys(parsed.items[0]!.scope)).toEqual([
      "endpointUrl",
      "authKind",
      "downscope",
    ]);
  });
});
