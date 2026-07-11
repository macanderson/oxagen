import { describe, expect, it } from "vitest";
import {
  AVATAR_MAX_LEN,
  AVATAR_SPEC_PREFIX,
  avatarUrlOutputSchema,
  avatarUrlSchema,
} from "./avatar";

describe("avatarUrlSchema", () => {
  it("accepts an https:// URL", () => {
    expect(avatarUrlSchema.parse("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
  });

  it("accepts a designed-avatar spec string", () => {
    const value = `${AVATAR_SPEC_PREFIX}{"emoji":"🦊","bg":"#f59e0b","mode":"full"}`;
    expect(avatarUrlSchema.parse(value)).toBe(value);
  });

  it("rejects a value with neither prefix", () => {
    expect(() => avatarUrlSchema.parse("not-a-valid-avatar")).toThrow();
  });

  it("rejects a value longer than the max length", () => {
    const tooLong = "https://" + "a".repeat(AVATAR_MAX_LEN);
    expect(() => avatarUrlSchema.parse(tooLong)).toThrow();
  });
});

describe("avatarUrlOutputSchema", () => {
  it("allows null for an unset avatar", () => {
    expect(avatarUrlOutputSchema.parse(null)).toBeNull();
  });

  it("passes through whatever is persisted without re-validating", () => {
    expect(avatarUrlOutputSchema.parse("anything")).toBe("anything");
  });
});
