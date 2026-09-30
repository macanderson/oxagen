import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { orgSlackConnectionAuthorize } from "./org.slack_connection.authorize";

const STATE = "A".repeat(43);

describe("org.slack_connection.authorize capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("authorize_slack_connection")).toBe(orgSlackConnectionAuthorize);
  });

  it("takes the state and the code, and nothing else", () => {
    expect(orgSlackConnectionAuthorize.input.parse({ state: STATE, code: "c-1" })).toEqual({
      state: STATE,
      code: "c-1",
    });
    expect(() =>
      orgSlackConnectionAuthorize.input.parse({ state: STATE, code: "c", orgId: "x" }),
    ).toThrow();
  });

  it("refuses a malformed state, an empty code, and an oversized code", () => {
    const parse = (input: unknown) => orgSlackConnectionAuthorize.input.safeParse(input).success;
    expect(parse({ state: "short", code: "c" })).toBe(false);
    expect(parse({ state: STATE, code: "" })).toBe(false);
    expect(parse({ state: STATE, code: "c".repeat(513) })).toBe(false);
  });

  it("returns the connection view", () => {
    const out = orgSlackConnectionAuthorize.output.parse({
      configured: true,
      connected: true,
      teamName: "Acme",
      channel: null,
      lastFailure: null,
      connectedAt: "2026-09-28T10:00:00.000Z",
    });
    expect(out.connected).toBe(true);
    expect(out.channel).toBeNull();
  });

  it("is governed: org Owner or Admin, high sensitivity, deny by default, app only", () => {
    expect(orgSlackConnectionAuthorize.scoped).toBe(false);
    expect(orgSlackConnectionAuthorize.mutates).toBe(true);
    expect(orgSlackConnectionAuthorize.sensitivity).toBe("high");
    expect(orgSlackConnectionAuthorize.defaultEffect).toBe("deny");
    expect(orgSlackConnectionAuthorize.noBillingGate).toBe(true);
    expect(orgSlackConnectionAuthorize.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSlackConnectionAuthorize.surfaces).toEqual([]);
  });
});
