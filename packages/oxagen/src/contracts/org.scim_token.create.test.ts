import { describe, expect, it } from "vitest";
import { orgScimTokenCreate } from "./org.scim_token.create";
import { getCapability } from "../registry";

describe("org.scim_token.create capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("create_scim_token")).toBe(orgScimTokenCreate);
  });

  it("is governed: org Owner or Admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgScimTokenCreate.scoped).toBe(false);
    expect(orgScimTokenCreate.sensitivity).toBe("high");
    expect(orgScimTokenCreate.defaultEffect).toBe("deny");
    expect(orgScimTokenCreate.noBillingGate).toBe(true);
    expect(orgScimTokenCreate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgScimTokenCreate.surfaces).toEqual(["api"]);
  });

  it("is not an agent tool", () => {
    expect("agent" in orgScimTokenCreate).toBe(false);
  });

  it("takes no input", () => {
    expect(orgScimTokenCreate.input.parse({})).toEqual({});
  });
});

describe("create_scim_token output", () => {
  it("carries the token, the endpoint and the prefix view", () => {
    const out = {
      token: "oxscim_abc",
      baseUrl: "https://app.oxagen.sh/api/scim/v2",
      view: {
        tokenPrefix: "oxscim_abc",
        createdAt: "2026-09-23T10:00:00.000Z",
        lastUsedAt: null,
      },
    };
    expect(orgScimTokenCreate.output.parse(out)).toEqual(out);
  });

  it("is kept off MCP, where the token would land in an agent's transcript", () => {
    expect(orgScimTokenCreate.surfaces).not.toContain("mcp");
  });
});
