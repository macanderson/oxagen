// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, initialsFontSize } from "./avatar";
import { renderWithIntl } from "./testing/render-with-intl";

afterEach(() => {
  cleanup();
});

describe("Avatar", () => {
  it("renders initials in the chosen tone and font, round for a person", () => {
    renderWithIntl(
      <Avatar
        avatar={{ kind: "initials", text: "MB", font: "serif", tone: "solid" }}
        size={40}
        label="Marcus Bell"
      />,
    );
    const avatar = screen.getByRole("img", { name: "Marcus Bell" });
    expect(avatar).toHaveTextContent("MB");
    expect(avatar).toHaveAttribute("data-kind", "initials");
    expect(avatar.className).toContain("rounded-full");
    expect(avatar.className).toContain("font-serif");
    expect(avatar.className).toContain("bg-foreground");
    expect(avatar.style.fontSize).toBe("17px");
  });

  it("keeps at most three initials", () => {
    renderWithIntl(<Avatar avatar={{ kind: "initials", text: "ABCD" }} />);
    expect(screen.getByTestId("avatar")).toHaveTextContent(/^ABC$/);
  });

  it("draws a Lucide glyph as a squircle for an agent", () => {
    renderWithIntl(
      <Avatar
        avatar={{ kind: "icon", icon: "rocket", tone: "line" }}
        shape="agent"
      />,
    );
    const avatar = screen.getByTestId("avatar");
    expect(avatar).toHaveAttribute("data-kind", "icon");
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(avatar.className).toContain("rounded-[30%]");
    expect(avatar.className).toContain("border-foreground/60");
    expect(avatar.querySelector("svg")).not.toBeNull();
  });

  it("renders a photo with an empty alt, since the label is on the frame", () => {
    renderWithIntl(
      <Avatar
        avatar={{ kind: "photo", src: "data:image/png;base64,iVBORw0KGgo=" }}
        label="Dana Okafor"
      />,
    );
    const frame = screen.getByRole("img", { name: "Dana Okafor" });
    expect(frame).toHaveAttribute("data-kind", "photo");
    expect(frame.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("falls back to a soft question mark when there is no avatar", () => {
    renderWithIntl(<Avatar avatar={null} />);
    const avatar = screen.getByTestId("avatar");
    expect(avatar).toHaveTextContent("?");
    expect(avatar.className).toContain("bg-muted");
  });
});

describe("initialsFontSize", () => {
  it("shrinks as the initials grow", () => {
    expect(initialsFontSize("A", 28)).toBe(14);
    expect(initialsFontSize("AB", 28)).toBe(12);
    expect(initialsFontSize("ABC", 28)).toBe(10);
  });
});
