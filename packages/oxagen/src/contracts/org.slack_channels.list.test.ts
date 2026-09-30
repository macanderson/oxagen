import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { orgSlackChannelsList } from "./org.slack_channels.list";

describe("org.slack_channels.list capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("list_slack_channels")).toBe(orgSlackChannelsList);
  });

  it("takes no input", () => {
    expect(orgSlackChannelsList.input.parse({})).toEqual({});
  });

  it("returns channels and whether the list was cut short", () => {
    const out = orgSlackChannelsList.output.parse({
      channels: [
        { id: "C024BE91L", name: "alerts", isPrivate: false },
        { id: "G0123456", name: "ops", isPrivate: true },
      ],
      truncated: true,
    });
    expect(out.channels).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("refuses a channel with a malformed id", () => {
    expect(() =>
      orgSlackChannelsList.output.parse({
        channels: [{ id: "D024BE91L", name: "dm", isPrivate: true }],
        truncated: false,
      }),
    ).toThrow();
  });

  it("is a governed read: org Owner or Admin, high sensitivity, deny by default", () => {
    expect(orgSlackChannelsList.scoped).toBe(false);
    expect(orgSlackChannelsList.mutates).toBe(false);
    expect(orgSlackChannelsList.sensitivity).toBe("high");
    expect(orgSlackChannelsList.defaultEffect).toBe("deny");
    expect(orgSlackChannelsList.noBillingGate).toBe(true);
    expect(orgSlackChannelsList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgSlackChannelsList.surfaces).toEqual([]);
  });
});
