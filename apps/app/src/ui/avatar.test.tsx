// @vitest-environment jsdom
// The avatar renderer over the three shapes a stored value can take. The test
// that matters is the designed one: `avatarUrlSchema` accepts an
// `avatar:v1:{...}` string everywhere an avatar is written, and a renderer that
// tests for `https://` alone shows initials to a person whose avatar is
// perfectly valid — silently, with nothing to tell them why.
import { cleanup, render, screen } from "@testing-library/react";
import { AVATAR_MAX_LEN, AVATAR_SPEC_PREFIX } from "@oxagen/oxagen/avatar";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, parseAvatarValue } from "./avatar";

const DESIGNED = 'avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"full"}';

afterEach(cleanup);

describe("parseAvatarValue", () => {
  // The prefix and the cap are the contract's, re-declared in avatar.tsx so a
  // client bundle does not pull zod in. This is what stops the two drifting.
  it("mirrors the contract's canonical prefix and length cap", () => {
    expect(
      parseAvatarValue(
        `${AVATAR_SPEC_PREFIX}{"emoji":"x","bg":"#000000","mode":"full"}`,
      ).kind,
    ).toBe("designed");
    expect(
      parseAvatarValue(`https://e.example/${"a".repeat(AVATAR_MAX_LEN)}`).kind,
    ).toBe("none");
  });

  it("reads a designed avatar into its emoji, background and mode", () => {
    expect(parseAvatarValue(DESIGNED)).toEqual({
      kind: "designed",
      emoji: "🦊",
      bg: "#f59e0b",
      mode: "full",
    });
  });

  it("reads an https URL as an image", () => {
    expect(parseAvatarValue("https://cdn.example/a.png")).toEqual({
      kind: "image",
      url: "https://cdn.example/a.png",
    });
  });

  it("degrades every malformed value to none rather than throwing (negative)", () => {
    for (const value of [
      null,
      undefined,
      "",
      "http://cdn.example/a.png",
      "not-a-url",
      "avatar:v1:{not json",
      'avatar:v1:{"emoji":"","bg":"#f59e0b","mode":"full"}',
      'avatar:v1:{"emoji":"🦊","bg":"#F59E0B","mode":"full"}',
      'avatar:v1:{"emoji":"🦊","bg":"orange","mode":"full"}',
      'avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"neon"}',
      'avatar:v1:["🦊"]',
      "avatar:v1:null",
    ])
      expect(parseAvatarValue(value).kind).toBe("none");
  });
});

describe("Avatar", () => {
  it("renders the designed avatar's emoji on its background, not the initials", () => {
    render(<Avatar value={DESIGNED} initials="MB" testId="a" />);
    const tile = screen.getByTestId("a");
    expect(tile.dataset.avatar).toBe("designed");
    expect(tile.textContent).toBe("🦊");
    expect(tile.style.backgroundColor).toBe("rgb(245, 158, 11)");
    expect(screen.queryByText("MB")).toBeNull();
  });

  it("renders a mono mode as a silhouette", () => {
    render(
      <Avatar
        value={'avatar:v1:{"emoji":"🦊","bg":"#101010","mode":"mono-light"}'}
        initials="MB"
        testId="a"
      />,
    );
    expect(screen.getByTestId("a").firstElementChild).toHaveStyle({
      filter: "brightness(0) invert(1)",
    });
  });

  it("renders an https value as a decorative image", () => {
    render(
      <Avatar value="https://cdn.example/a.png" initials="MB" testId="a" />,
    );
    const img = screen.getByTestId("a");
    expect(img.tagName).toBe("IMG");
    expect(img).toHaveAttribute("src", "https://cdn.example/a.png");
    expect(img).toHaveAttribute("alt", "");
  });

  it("falls back to initials when the value names no avatar (negative)", () => {
    render(<Avatar value="not-an-avatar" initials="MB" testId="a" />);
    const tile = screen.getByTestId("a");
    expect(tile.dataset.avatar).toBe("initials");
    expect(tile.textContent).toBe("MB");
  });
});
