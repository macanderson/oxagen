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

  // MCP authenticates with an API key and `resolveMcpContext` builds every
  // context with `userId: null`, so a machine credential has no own profile
  // to change: an MCP tool here could only ever return forbidden. The surface
  // list is pinned so the tool cannot be re-advertised without the principal
  // arriving first.
  it("carries no MCP surface while MCP contexts carry no person", () => {
    expect(userProfileUpdate.surfaces).toEqual(["api"]);
    expect(userProfileUpdate.layers).not.toContain("mcp");
  });

  it("answers with the persisted display name and avatar", () => {
    const output = { displayName: "Ada Lovelace", avatarUrl: null };
    expect(userProfileUpdate.output.parse(output)).toEqual(output);
    expect(
      userProfileUpdate.output.safeParse({ displayName: "Ada" }).success,
    ).toBe(false);
  });
});
