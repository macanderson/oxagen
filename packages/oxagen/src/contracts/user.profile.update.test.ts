import { describe, expect, it } from "vitest";
import { userProfileUpdate } from "./user.profile.update";

describe("update_profile contract", () => {
  it("is a user-global identity write: unscoped, mutating, noBillingGate", () => {
    expect(userProfileUpdate.scoped).toBe(false);
    expect(userProfileUpdate.mutates).toBe(true);
    expect(userProfileUpdate.noBillingGate).toBe(true);
  });

  it("accepts a trimmed display name and a null avatar", () => {
    expect(
      userProfileUpdate.input.parse({
        displayName: "  Ada Lovelace  ",
        avatarUrl: null,
      }),
    ).toEqual({ displayName: "Ada Lovelace", avatarUrl: null });
  });

  it("accepts an https avatar URL and a designed-avatar spec string", () => {
    expect(
      userProfileUpdate.input.parse({
        displayName: "Ada",
        avatarUrl: "https://example.com/a.png",
      }).avatarUrl,
    ).toBe("https://example.com/a.png");
    expect(
      userProfileUpdate.input.parse({
        displayName: "Ada",
        avatarUrl: 'avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"full"}',
      }).avatarUrl,
    ).toBe('avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"full"}');
  });

  it("rejects a display name over 120 characters (negative)", () => {
    expect(
      userProfileUpdate.input.safeParse({
        displayName: "a".repeat(121),
        avatarUrl: null,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty display name (negative)", () => {
    expect(
      userProfileUpdate.input.safeParse({ displayName: "", avatarUrl: null })
        .success,
    ).toBe(false);
    expect(
      userProfileUpdate.input.safeParse({ displayName: "   ", avatarUrl: null })
        .success,
    ).toBe(false);
  });

  it("rejects an avatar value that is neither an https URL nor a spec string (negative)", () => {
    expect(
      userProfileUpdate.input.safeParse({
        displayName: "Ada",
        avatarUrl: "http://insecure.example.com/a.png",
      }).success,
    ).toBe(false);
    expect(
      userProfileUpdate.input.safeParse({
        displayName: "Ada",
        avatarUrl: "not-a-url",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown key (negative)", () => {
    expect(
      userProfileUpdate.input.safeParse({
        displayName: "Ada",
        avatarUrl: null,
        extra: true,
      }).success,
    ).toBe(false);
  });

  // The whole point of this contract: it must act on the calling principal
  // only. A user-id field here would let one caller rewrite another's
  // identity, so the input schema must never grow one.
  it("has no user-id field in its input schema (privilege-escalation guard)", () => {
    const keys = Object.keys(userProfileUpdate.input.shape);
    expect(keys).toEqual(["displayName", "avatarUrl"]);
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain("userid");
      expect(key.toLowerCase()).not.toBe("id");
    }
  });

  // The handler acts on `ctx.userId` alone, and `resolveMcpContext` builds
  // every MCP context with `userId: null` (an API key carries no person) —
  // so an MCP tool for this capability could only ever answer `forbidden`.
  // Advertising one is a broken surface; resolving the key's creator instead
  // would let a machine credential rewrite a person's identity. API only.
  it("is not exposed on MCP, agent or CLI: no surface can carry a person but the API", () => {
    expect(userProfileUpdate.surfaces).toEqual(["api"]);
    expect(userProfileUpdate.surfaces).not.toContain("mcp");
    expect(userProfileUpdate.layers).not.toContain("mcp");
    expect(userProfileUpdate.layers).not.toContain("cli");
    expect(userProfileUpdate.layers).not.toContain("agent");
  });

  it("answers with the persisted display name and avatar", () => {
    const output = { displayName: "Ada Lovelace", avatarUrl: null };
    expect(userProfileUpdate.output.parse(output)).toEqual(output);
    expect(
      userProfileUpdate.output.safeParse({ displayName: "Ada" }).success,
    ).toBe(false);
  });
});
