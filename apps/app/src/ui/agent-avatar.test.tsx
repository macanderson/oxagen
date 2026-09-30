// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentAvatar } from "./agent-avatar";

afterEach(cleanup);

describe("AgentAvatar", () => {
  it.each(["claude-code", "codex", "cursor", "stella"])(
    "overlays the %s mark on the agent's initials",
    (harness) => {
      const { container } = render(
        <AgentAvatar value={null} initials="RB" harness={harness} />,
      );
      expect(container.querySelector("[data-avatar]")).toHaveTextContent("RB");
      const badge = container.querySelector("[data-harness-badge]");
      expect(badge).toHaveAttribute("data-harness-badge", harness);
      expect(badge?.querySelector("[data-harness-mark]")).toHaveAttribute(
        "data-harness-mark",
        harness,
      );
      expect(badge?.querySelector("img")).toHaveAttribute(
        "src",
        harness === "stella"
          ? "/brand/stella-icon.svg"
          : `/harnesses/${harness}-light.svg`,
      );
      if (harness !== "stella") {
        expect(badge?.querySelectorAll("img")[1]).toHaveAttribute(
          "src",
          `/harnesses/${harness}-dark.svg`,
        );
      }
      expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    },
  );

  it.each([
    [18, 10],
    [28, 13],
    [30, 14],
    [56, 26],
  ])(
    "keeps the badge outside the lower left of a %ipx avatar",
    (size, badgeSize) => {
      const { container } = render(
        <AgentAvatar value={null} initials="RB" harness="codex" size={size} />,
      );
      expect(container.firstElementChild).toHaveStyle({
        width: `${String(size)}px`,
        height: `${String(size)}px`,
      });
      expect(container.firstElementChild).not.toHaveClass("overflow-hidden");
      const badge = container.querySelector("[data-harness-badge]");
      expect(badge).toHaveClass(
        "absolute",
        "-bottom-[3px]",
        "-left-[3px]",
        "rounded-full",
      );
      expect(badge).toHaveStyle({
        width: `${String(badgeSize)}px`,
        height: `${String(badgeSize)}px`,
      });
    },
  );

  it.each([null, undefined, ""])(
    "omits the badge when the harness is %s",
    (harness) => {
      const { container } = render(
        <AgentAvatar value={null} initials="RB" harness={harness} />,
      );
      expect(container.querySelector("[data-avatar]")).toHaveTextContent("RB");
      expect(container.querySelector("[data-harness-badge]")).toBeNull();
    },
  );

  it("uses the generic mark for a custom harness", () => {
    const { container } = render(
      <AgentAvatar value={null} initials="RB" harness="custom-runner" />,
    );
    const badge = container.querySelector("[data-harness-badge]");
    expect(badge?.querySelector("svg")).toBeTruthy();
    expect(badge?.querySelector("img")).toBeNull();
  });

  it("preserves the badge when an image fails and falls back to initials", () => {
    const { container } = render(
      <AgentAvatar
        value="https://avatars.example.com/release.png"
        initials="RB"
        harness="claude-code"
      />,
    );
    const avatar = container.querySelector('[data-avatar="image"]');
    if (avatar === null) throw new Error("the stored avatar was not drawn");
    fireEvent.error(avatar);
    expect(container.querySelector("[data-avatar]")).toHaveTextContent("RB");
    expect(container.querySelector("[data-harness-mark]")).toHaveAttribute(
      "data-harness-mark",
      "claude-code",
    );
  });

  it("preserves a designed avatar beneath the harness mark", () => {
    const { container } = render(
      <AgentAvatar
        value={'avatar:v1:{"kind":"icon","icon":"rocket","tone":"solid"}'}
        initials="RB"
        harness="stella"
      />,
    );
    expect(container.querySelector("[data-avatar]")).toHaveAttribute(
      "data-icon",
      "rocket",
    );
    expect(container.querySelector("[data-harness-mark]")).toHaveAttribute(
      "data-harness-mark",
      "stella",
    );
  });
});
