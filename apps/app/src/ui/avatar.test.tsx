// @vitest-environment jsdom
// The avatar renderer over the shapes a stored value can take: an https image,
// a designed icon, a designed monogram, and the initials fallback. The test
// that matters is the designed one: `avatarUrlSchema` accepts an
// `avatar:v1:{...}` string everywhere an avatar is written, and a renderer that
// tests for `https://` alone shows initials to a person whose avatar is
// perfectly valid, silently, with nothing to tell them why.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AVATAR_MAX_LEN, AVATAR_SPEC_PREFIX } from "@oxagen/oxagen/avatar";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./avatar";
import {
  AVATAR_ICONS,
  AVATAR_TONES,
  INITIALS_MAX,
  monogram,
  parseAvatarValue,
  serializeAvatar,
} from "./avatar-spec";

const ICON = 'avatar:v1:{"kind":"icon","icon":"rocket","tone":"solid"}';
const MONOGRAM =
  'avatar:v1:{"kind":"initials","text":"MB","font":"serif","tone":"line"}';

afterEach(cleanup);

function drawn(value: string | null | undefined): HTMLElement {
  cleanup();
  render(<Avatar value={value} initials="MB" testId="k" />);
  return screen.getByTestId("k");
}

describe("the spec", () => {
  // The prefix and the cap are the contract's, re-declared in avatar-spec.ts so
  // a client bundle does not pull zod in. This is what stops the two drifting,
  // and it asserts the behaviour rather than the copy: a value written at the
  // contract's prefix parses, and the contract's cap is exactly where the
  // parser stops reading one.
  it("mirrors the contract's canonical prefix and length cap", () => {
    const spec = `${AVATAR_SPEC_PREFIX}{"kind":"icon","icon":"rocket","tone":"solid"}`;
    expect(parseAvatarValue(spec).kind).toBe("icon");

    const url = (length: number) =>
      `https://a.example/${"b".repeat(length - "https://a.example/".length)}`;
    expect(parseAvatarValue(url(AVATAR_MAX_LEN)).kind).toBe("image");
    expect(parseAvatarValue(url(AVATAR_MAX_LEN + 1)).kind).toBe("none");
  });

  it("round-trips an icon and a monogram through the stored string", () => {
    for (const value of [ICON, MONOGRAM]) {
      const parsed = parseAvatarValue(value);
      expect(parsed.kind === "icon" || parsed.kind === "initials").toBe(true);
      if (parsed.kind === "icon" || parsed.kind === "initials")
        expect(serializeAvatar(parsed)).toBe(value);
    }
  });

  it("offers the three theme tones and the two golds, in that order", () => {
    expect(AVATAR_TONES).toEqual([
      "solid",
      "soft",
      "line",
      "gold",
      "gold-deep",
    ]);
    for (const tone of AVATAR_TONES) {
      const value = `avatar:v1:{"kind":"icon","icon":"rocket","tone":"${tone}"}`;
      const parsed = parseAvatarValue(value);
      expect(parsed).toEqual({ kind: "icon", icon: "rocket", tone });
      if (parsed.kind === "icon") expect(serializeAvatar(parsed)).toBe(value);
    }
  });

  it("keeps a monogram to six upper-case letters", () => {
    expect(INITIALS_MAX).toBe(6);
    expect(monogram("  marcus bell ")).toBe("MARCUS");
    expect(
      serializeAvatar({
        kind: "initials",
        text: "abcdefgh",
        font: "mono",
        tone: "soft",
      }),
    ).toBe(
      'avatar:v1:{"kind":"initials","text":"ABCDEF","font":"mono","tone":"soft"}',
    );
  });

  it("ships the mockup's twenty-four Lucide glyphs", () => {
    expect(AVATAR_ICONS).toHaveLength(24);
    expect(AVATAR_ICONS).toContain("rocket");
    expect(AVATAR_ICONS).toContain("shield-check");
  });

  it("reads every well-formed value, and nothing else (negative)", () => {
    expect(parseAvatarValue("https://cdn.example/a.png")).toEqual({
      kind: "image",
      url: "https://cdn.example/a.png",
    });
    for (const value of [
      null,
      undefined,
      "",
      "http://cdn.example/a.png",
      "not-a-url",
      "avatar:v1:{not json",
      'avatar:v1:{"kind":"icon","icon":"dragon","tone":"solid"}',
      'avatar:v1:{"kind":"icon","icon":"rocket","tone":"neon"}',
      'avatar:v1:{"kind":"initials","text":"  ","font":"sans","tone":"soft"}',
      'avatar:v1:{"kind":"initials","text":"MB","font":"comic","tone":"soft"}',
      'avatar:v1:{"kind":"photo","src":"data:image/png;base64,AAAA"}',
      'avatar:v1:["rocket"]',
      "avatar:v1:null",
      `https://e.example/${"a".repeat(AVATAR_MAX_LEN)}`,
    ]) {
      expect(parseAvatarValue(value)).toEqual({ kind: "none" });
      expect(() => drawn(value)).not.toThrow();
      expect(screen.getByTestId("k").dataset.avatar).toBe("initials");
    }
  });
});

describe("the emoji body stored before the W11 editor", () => {
  const LEGACY = 'avatar:v1:{"emoji":"\u{1F98A}","bg":"#f59e0b","mode":"full"}';

  // `avatarUrlSchema` accepted this body and still does, so profiles,
  // workspaces and agents hold it. A parser that reads only the new shapes
  // turns every one of them into the initials fallback, silently, without
  // anyone editing anything.
  it("still reads, so an avatar set years ago is still the avatar", () => {
    expect(parseAvatarValue(LEGACY)).toEqual({ kind: "emoji", emoji: "\u{1F98A}" });
  });

  it("draws the emoji on a house tone, not the free colour it stored", () => {
    const tile = drawn(LEGACY);
    expect(tile.dataset.avatar).toBe("emoji");
    expect(tile.dataset.tone).toBe("soft");
    expect(tile.textContent).toBe("\u{1F98A}");
    // The body's own `bg` was a free hex colour, which the house scale replaced.
    expect(tile.getAttribute("style") ?? "").not.toContain("#f59e0b");
  });

  it("is never written back: an empty emoji is not an avatar", () => {
    expect(
      parseAvatarValue('avatar:v1:{"emoji":"","bg":"#000","mode":"full"}'),
    ).toEqual({ kind: "none" });
  });
});

describe("Avatar", () => {
  it("draws a designed icon in its tone, not the initials", () => {
    const tile = drawn(ICON);
    expect(tile.dataset.avatar).toBe("icon");
    expect(tile.dataset.icon).toBe("rocket");
    expect(tile.dataset.tone).toBe("solid");
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("MB")).toBeNull();
  });

  it("draws a monogram in its typeface and tone, scaled to its length", () => {
    const tile = drawn(MONOGRAM);
    expect(tile.dataset.avatar).toBe("initials");
    expect(tile.dataset.font).toBe("serif");
    expect(tile.dataset.tone).toBe("line");
    expect(tile.textContent).toBe("MB");
    expect(tile.className).toContain("font-serif");

    const six = drawn(
      'avatar:v1:{"kind":"initials","text":"MARCUS","font":"mono","tone":"soft"}',
    );
    expect(six.textContent).toBe("MARCUS");
    expect(parseFloat(six.style.fontSize)).toBeLessThan(
      parseFloat(tile.style.fontSize),
    );
  });

  it("draws the brand gold and its deep shade, each with its own glyph ink", () => {
    const gold = drawn(
      'avatar:v1:{"kind":"icon","icon":"rocket","tone":"gold"}',
    );
    expect(gold.dataset.tone).toBe("gold");
    expect(gold.className).toContain("bg-gold ");
    expect(gold.className).toContain("text-on-gold ");

    const deep = drawn(
      'avatar:v1:{"kind":"initials","text":"OX","font":"sans","tone":"gold-deep"}',
    );
    expect(deep.dataset.tone).toBe("gold-deep");
    expect(deep.className).toContain("bg-gold-deep");
    expect(deep.className).toContain("text-on-gold-deep");
    expect(deep.textContent).toBe("OX");
  });

  it("sizes the tile in pixels and scales the type with it", () => {
    render(
      <>
        <Avatar value={null} initials="MB" size={30} testId="t" />
        <Avatar value={null} initials="MB" size={72} testId="p" />
      </>,
    );
    expect(screen.getByTestId("t").style.width).toBe("30px");
    expect(screen.getByTestId("p").style.width).toBe("72px");
    expect(parseFloat(screen.getByTestId("p").style.fontSize)).toBeGreaterThan(
      parseFloat(screen.getByTestId("t").style.fontSize),
    );
  });

  it("is round for a person and a squircle for an agent", () => {
    render(
      <>
        <Avatar value={ICON} initials="MB" testId="p" />
        <Avatar value={ICON} initials="MB" shape="agent" testId="a" />
      </>,
    );
    expect(screen.getByTestId("p").className).toContain("rounded-full");
    expect(screen.getByTestId("a").className).toContain("rounded-[27%]");
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

  it("falls back to soft initials when the value names no avatar (negative)", () => {
    render(<Avatar value="not-an-avatar" initials="MB" testId="a" />);
    const tile = screen.getByTestId("a");
    expect(tile.dataset.avatar).toBe("initials");
    expect(tile.dataset.tone).toBe("soft");
    expect(tile.textContent).toBe("MB");
  });
});
