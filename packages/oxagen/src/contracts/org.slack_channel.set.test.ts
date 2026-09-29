import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { orgSlackChannelSet } from "./org.slack_channel.set";

describe("org.slack_channel.set capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("set_slack_channel")).toBe(orgSlackChannelSet);
  });

  it("takes a channel id and nothing else", () => {
    expect(orgSlackChannelSet.input.parse({ channelId: "C024BE91L" })).toEqual({
      channelId: "C024BE91L",
    });
    expect(() =>
      orgSlackChannelSet.input.parse({ channelId: "C024BE91L", name: "alerts" }),
    ).toThrow();
    expect(() => orgSlackChannelSet.input.parse({ channelId: "#alerts" })).toThrow();
  });

  it("returns the connection view with the picked channel", () => {
    const out = orgSlackChannelSet.output.parse({
      configured: true,
      connected: true,
      teamName: "Acme",
      channel: { id: "C024BE91L", name: "alerts", isPrivate: false },
      lastFailure: null,
      connectedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(out.channel?.id).toBe("C024BE91L");
  });

  it("is governed: org Owner or Admin, high sensitivity, deny by default, app only", () => {
    expect(orgSlackChannelSet.scoped).toBe(false);
    expect(orgSlackChannelSet.mutates).toBe(true);
    expect(orgSlackChannelSet.sensitivity).toBe("high");
    expect(orgSlackChannelSet.defaultEffect).toBe("deny");
    expect(orgSlackChannelSet.noBillingGate).toBe(true);
    expect(orgSlackChannelSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSlackChannelSet.surfaces).toEqual([]);
  });
});
