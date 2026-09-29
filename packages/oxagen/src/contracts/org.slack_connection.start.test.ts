import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { orgSlackConnectionStart } from "./org.slack_connection.start";

describe("org.slack_connection.start capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("start_slack_connection")).toBe(orgSlackConnectionStart);
  });

  it("takes no input and refuses extra fields", () => {
    expect(orgSlackConnectionStart.input.parse({})).toEqual({});
    expect(() => orgSlackConnectionStart.input.parse({ orgId: "x" })).toThrow();
  });

  it("returns an absolute authorize URL", () => {
    const authorizeUrl = "https://slack.com/oauth/v2/authorize?client_id=1&state=s";
    expect(orgSlackConnectionStart.output.parse({ authorizeUrl })).toEqual({ authorizeUrl });
    expect(() => orgSlackConnectionStart.output.parse({ authorizeUrl: "/relative" })).toThrow();
  });

  it("is governed: org Owner or Admin, high sensitivity, deny by default, app only", () => {
    expect(orgSlackConnectionStart.scoped).toBe(false);
    expect(orgSlackConnectionStart.mutates).toBe(true);
    expect(orgSlackConnectionStart.sensitivity).toBe("high");
    expect(orgSlackConnectionStart.defaultEffect).toBe("deny");
    expect(orgSlackConnectionStart.noBillingGate).toBe(true);
    expect(orgSlackConnectionStart.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSlackConnectionStart.surfaces).toEqual([]);
  });
});
