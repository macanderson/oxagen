import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { orgSlackConnectionDelete } from "./org.slack_connection.delete";

describe("org.slack_connection.delete capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("delete_slack_connection")).toBe(orgSlackConnectionDelete);
  });

  it("takes no input and refuses extra fields", () => {
    expect(orgSlackConnectionDelete.input.parse({})).toEqual({});
    expect(() => orgSlackConnectionDelete.input.parse({ teamId: "T1" })).toThrow();
  });

  it("returns the disconnected view", () => {
    const out = orgSlackConnectionDelete.output.parse({
      configured: true,
      connected: false,
      teamName: null,
      channel: null,
      lastFailure: null,
      connectedAt: null,
    });
    expect(out.connected).toBe(false);
  });

  it("is governed: org Owner or Admin, high sensitivity, deny by default, app only", () => {
    expect(orgSlackConnectionDelete.scoped).toBe(false);
    expect(orgSlackConnectionDelete.mutates).toBe(true);
    expect(orgSlackConnectionDelete.sensitivity).toBe("high");
    expect(orgSlackConnectionDelete.defaultEffect).toBe("deny");
    expect(orgSlackConnectionDelete.noBillingGate).toBe(true);
    expect(orgSlackConnectionDelete.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSlackConnectionDelete.surfaces).toEqual([]);
  });
});
