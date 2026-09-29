import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { orgSlackConnectionGet } from "./org.slack_connection.get";

describe("org.slack_connection.get capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("get_slack_connection")).toBe(orgSlackConnectionGet);
  });

  it("takes no input", () => {
    expect(orgSlackConnectionGet.input.parse({})).toEqual({});
  });

  it("parses the view of a deployment that cannot connect Slack", () => {
    const out = orgSlackConnectionGet.output.parse({
      configured: false,
      connected: false,
      teamName: null,
      channel: null,
      lastFailure: null,
      connectedAt: null,
    });
    expect(out.configured).toBe(false);
  });

  it("parses a connection with a channel and a failure on record", () => {
    const out = orgSlackConnectionGet.output.parse({
      configured: true,
      connected: true,
      teamName: "Acme",
      channel: { id: "C024BE91L", name: "alerts", isPrivate: true },
      lastFailure: { code: "not_in_channel", at: "2026-09-28T10:00:00.000Z" },
      connectedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(out.channel?.isPrivate).toBe(true);
    expect(out.lastFailure?.code).toBe("not_in_channel");
  });

  it("strips a token a handler returned by mistake", () => {
    const out = orgSlackConnectionGet.output.parse({
      configured: true,
      connected: true,
      teamName: "Acme",
      channel: null,
      lastFailure: null,
      connectedAt: null,
      tokenEnvelope: { keyId: "k", ciphertext: "s3cret" },
    });
    expect(out).not.toHaveProperty("tokenEnvelope");
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("is a governed read: org Owner or Admin, high sensitivity, deny by default", () => {
    expect(orgSlackConnectionGet.scoped).toBe(false);
    expect(orgSlackConnectionGet.mutates).toBe(false);
    expect(orgSlackConnectionGet.sensitivity).toBe("high");
    expect(orgSlackConnectionGet.defaultEffect).toBe("deny");
    expect(orgSlackConnectionGet.noBillingGate).toBe(true);
    expect(orgSlackConnectionGet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSlackConnectionGet.surfaces).toEqual([]);
  });
});
