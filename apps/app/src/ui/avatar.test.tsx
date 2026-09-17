// @vitest-environment jsdom
// The avatar renderer over the three shapes a stored value can take. The test
// that matters is the designed one: `avatarUrlSchema` accepts an
// `avatar:v1:{...}` string everywhere an avatar is written, and a renderer that
// tests for `https://` alone shows initials to a person whose avatar is
// perfectly valid — silently, with nothing to tell them why.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AVATAR_MAX_LEN, AVATAR_SPEC_PREFIX } from "@oxagen/oxagen/avatar";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./avatar";

const DESIGNED = 'avatar:v1:{"emoji":"🦊","bg":"#f59e0b","mode":"full"}';

afterEach(cleanup);

/**
 * The parser is not exported — it is an implementation detail of the one
 * renderer that uses it — so every reading of a stored value is asserted
 * through what the renderer draws: `image`, `designed` or the `initials`
 * fallback. That is also the only thing a person ever sees.
 */
function drawn(value: string | null | undefined): HTMLElement {
  cleanup();
  render(<Avatar value={value} initials="MB" testId="k" />);
  return screen.getByTestId("k");
}

describe("reading a stored avatar value", () => {
  // The prefix and the cap are the contract's, re-declared in avatar.tsx so a
  // client bundle does not pull zod in. This is what stops the two drifting.
  it("mirrors the contract's canonical prefix and length cap", () => {
    expect(
      drawn(`${AVATAR_SPEC_PREFIX}{"emoji":"x","bg":"#000000","mode":"full"}`)
        .dataset.avatar,
    ).toBe("designed");
    expect(
      drawn(`https://e.example/${"a".repeat(AVATAR_MAX_LEN)}`).dataset.avatar,
    ).toBe("initials");
  });

  it("reads a designed avatar into its emoji, background and mode", () => {
    const tile = drawn(DESIGNED);
    expect(tile.dataset.avatar).toBe("designed");
    expect(tile.textContent).toBe("🦊");
    expect(tile.style.backgroundColor).toBe("rgb(245, 158, 11)");
  });

  it("reads an https URL as an image", () => {
    const tile = drawn("https://cdn.example/a.png");
    expect(tile.dataset.avatar).toBe("image");
    expect(tile).toHaveAttribute("src", "https://cdn.example/a.png");
  });

  it("degrades every malformed value to the initials tile, never throwing (negative)", () => {
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
    ]) {
      expect(() => drawn(value)).not.toThrow();
      expect(screen.getByTestId("k").dataset.avatar).toBe("initials");
    }
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

  // An emoji does not scale with its tile, so the two call sites -- a 32px
  // trigger and a 52px editor preview -- need their own glyph steps or the
  // emoji is lost in the circle at one of them.
  it("draws each size with its own tile and glyph steps, in lockstep", () => {
    render(
      <>
        <Avatar value={DESIGNED} initials="MB" size="trigger" testId="t" />
        <Avatar value={DESIGNED} initials="MB" size="preview" testId="p" />
        <Avatar value={null} initials="MB" size="trigger" testId="ti" />
        <Avatar value={null} initials="MB" size="preview" testId="pi" />
      </>,
    );
    expect(screen.getByTestId("t").className).toContain("size-8");
    expect(screen.getByTestId("t").className).toContain("text-base");
    expect(screen.getByTestId("p").className).toContain("size-13");
    expect(screen.getByTestId("p").className).toContain("text-2xl");
    expect(screen.getByTestId("ti").className).toContain("size-8");
    expect(screen.getByTestId("ti").className).toContain("text-xs");
    expect(screen.getByTestId("pi").className).toContain("size-13");
    expect(screen.getByTestId("pi").className).toContain("text-base");
  });

  it("defaults to the preview size", () => {
    render(<Avatar value={null} initials="MB" testId="a" />);
    expect(screen.getByTestId("a").className).toContain("size-13");
  });

  // A well-formed URL is not a loadable image: the contract checks the
  // `https://` prefix and cannot know the host will 404, expire the object or
  // refuse the hotlink. Without this the shell shows a broken image until the
  // person edits their profile again.
  it("falls back to initials when the image fails to load (negative)", () => {
    render(
      <Avatar value="https://cdn.example/gone.png" initials="MB" testId="a" />,
    );
    expect(screen.getByTestId("a").dataset.avatar).toBe("image");

    fireEvent.error(screen.getByTestId("a"));

    const tile = screen.getByTestId("a");
    expect(tile.dataset.avatar).toBe("initials");
    expect(tile.textContent).toBe("MB");
    expect(tile.tagName).not.toBe("IMG");
  });

  // It remembers which url failed, not that one did, so editing the field to a
  // different URL tries again instead of staying on the fallback forever.
  it("tries again when the value changes to a different url", () => {
    const { rerender } = render(
      <Avatar value="https://cdn.example/gone.png" initials="MB" testId="a" />,
    );
    fireEvent.error(screen.getByTestId("a"));
    expect(screen.getByTestId("a").dataset.avatar).toBe("initials");

    rerender(
      <Avatar value="https://cdn.example/works.png" initials="MB" testId="a" />,
    );
    expect(screen.getByTestId("a").dataset.avatar).toBe("image");
    expect(screen.getByTestId("a")).toHaveAttribute(
      "src",
      "https://cdn.example/works.png",
    );
  });

  it("falls back to initials when the value names no avatar (negative)", () => {
    render(<Avatar value="not-an-avatar" initials="MB" testId="a" />);
    const tile = screen.getByTestId("a");
    expect(tile.dataset.avatar).toBe("initials");
    expect(tile.textContent).toBe("MB");
  });
});
