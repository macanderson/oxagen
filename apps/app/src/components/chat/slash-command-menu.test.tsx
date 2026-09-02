// @vitest-environment jsdom
/**
 * slash-command-menu.test.tsx
 *
 * Unit tests for SlashCommandMenu — the presentational autocomplete overlay:
 *   - Renders one option per command; the option at activeIndex is aria-selected
 *   - Clicking an option calls onSelect with that command
 *   - Renders nothing (returns null) when the command list is empty
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SlashCommand } from "@oxagen/ai/slash-commands";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const COMMANDS: readonly SlashCommand[] = [
  { name: "pr", args: "<pr-number>", summary: "Show pull-request stats." },
  { name: "ci", args: "[ref]", summary: "Show CI / check status." },
  {
    name: "pin",
    summary: "Pin the selected repo + environment.",
    clientAction: "pin",
  },
];

describe("SlashCommandMenu", () => {
  it("renders one option per command with the active index aria-selected", async () => {
    const { SlashCommandMenu } = await import("./slash-command-menu");
    render(
      <SlashCommandMenu
        commands={COMMANDS}
        activeIndex={1}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />,
    );
    expect(screen.getByTestId("slash-command-menu")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[2]).toHaveAttribute("aria-selected", "false");
  });

  it("calls onSelect with the clicked command", async () => {
    const onSelect = vi.fn();
    const { SlashCommandMenu } = await import("./slash-command-menu");
    render(
      <SlashCommandMenu
        commands={COMMANDS}
        activeIndex={0}
        onSelect={onSelect}
        onHoverIndex={vi.fn()}
      />,
    );
    await userEvent.click(screen.getAllByRole("option")[2]!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(COMMANDS[2]);
  });

  it("renders nothing when there are no commands", async () => {
    const { SlashCommandMenu } = await import("./slash-command-menu");
    const { container } = render(
      <SlashCommandMenu
        commands={[]}
        activeIndex={0}
        onSelect={vi.fn()}
        onHoverIndex={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("slash-command-menu")).not.toBeInTheDocument();
  });
});
