import { describe, expect, it } from "vitest";
import {
  slackChannelIdSchema,
  slackConnectionViewSchema,
  slackOAuthStateSchema,
} from "./org.slack_connection.shared";

describe("org.slack_connection shared schemas", () => {
  it("accepts public and private channel ids and refuses a DM or junk", () => {
    expect(slackChannelIdSchema.parse("C024BE91L")).toBe("C024BE91L");
    expect(slackChannelIdSchema.parse("G0123456")).toBe("G0123456");
    for (const bad of ["D024BE91L", "c024be91l", "C1", "", `C${"A".repeat(40)}`])
      expect(slackChannelIdSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a 43-character base64url state and nothing else", () => {
    const state = "a".repeat(42) + "_";
    expect(slackOAuthStateSchema.parse(state)).toBe(state);
    expect(slackOAuthStateSchema.safeParse("a".repeat(42)).success).toBe(false);
    expect(slackOAuthStateSchema.safeParse(`${"a".repeat(42)}=`).success).toBe(false);
  });

  it("strips a token a handler returned by mistake", () => {
    const out = slackConnectionViewSchema.parse({
      configured: true,
      connected: true,
      teamName: "Acme",
      channel: { id: "C024BE91L", name: "alerts", isPrivate: false },
      lastFailure: null,
      connectedAt: "2026-09-28T10:00:00.000Z",
      accessToken: "xoxb-s3cret",
    });
    expect(out).not.toHaveProperty("accessToken");
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });
});
