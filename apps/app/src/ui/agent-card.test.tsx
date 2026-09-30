// @vitest-environment jsdom
// The one agent identity component: the key under a two-letter avatar, a line
// under it, in three layouts. A key the store did not record reads as the
// caller's "not recorded" words with no avatar, never as an empty tile or a
// guessed name.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCard } from "./agent-card";

afterEach(cleanup);

describe("AgentCard", () => {
  it("draws the key with its full value on hover and the slug's first two letters as the avatar", () => {
    const { container } = render(
      <AgentCard
        agentKey="acme.core.release-bot"
        harness="claude-code"
        notRecorded="not recorded"
        sub="Claude Code"
      />,
    );
    const key = screen.getByText("acme.core.release-bot");
    expect(key).toHaveAttribute("title", "acme.core.release-bot");
    const avatar = container.querySelector("[aria-hidden='true']");
    expect(avatar).toHaveTextContent(/^RE$/);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // The list layout is the default.
    expect(container.firstElementChild).toHaveAttribute("data-layout", "list");
  });

  it("says the key was not recorded and draws no avatar when the store names no agent (negative)", () => {
    const { container } = render(
      <AgentCard
        agentKey={null}
        harness="codex"
        notRecorded="not recorded"
        sub="harness not recorded"
        layout="compact"
      />,
    );
    expect(screen.getByText("not recorded")).toBeTruthy();
    expect(container.querySelector("[aria-hidden='true']")).toBeNull();
    expect(container.querySelector("[title]")).toBeNull();
    expect(screen.getByText("harness not recorded")).toBeTruthy();
  });

  it.each<["list" | "compact" | "detail", number, string, boolean]>([
    ["list", 28, "truncate", false],
    ["compact", 30, "truncate", true],
    // The agent page's header wraps a long key rather than cutting it.
    ["detail", 56, "break-words", false],
  ])(
    "sizes the %s layout's avatar to %s and its key to its place, as a pill only when compact",
    (layout, avatarSize, keyClass, pill) => {
      const { container } = render(
        <AgentCard
          agentKey="acme.core.release-bot"
          harness="claude-code"
          notRecorded="not recorded"
          sub="line"
          layout={layout}
        />,
      );
      const card = container.firstElementChild;
      expect(card).toHaveAttribute("data-layout", layout);
      expect(
        container.querySelector("[data-agent-avatar]"),
      ).toHaveStyle({
        width: `${String(avatarSize)}px`,
        height: `${String(avatarSize)}px`,
      });
      expect(container.querySelector("[data-harness-mark]")).toHaveAttribute(
        "data-harness-mark",
        "claude-code",
      );
      expect(screen.getByText("acme.core.release-bot").className).toContain(
        keyClass,
      );
      expect(card?.className.includes("rounded-[10px]")).toBe(pill);
    },
  );
});
