// @vitest-environment jsdom
// The read-only diff the agent source editor draws on. DiffPanel draws both
// gutters, a sign beside the tint so the change survives greyscale, keeps a
// blank line as a row, and puts the path and the stat where a screen reader
// reaches them. Axe runs on the state each test ends in (INV-26).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiff } from "@/shared/line-diff";
import { expectNoAxe } from "@/test/expect-no-axe";
import { DiffPanel } from "./code-panel";

afterEach(cleanup);

/** The numbers down the left of a panel, in the order they are drawn. */
function gutters(container: Element): string[][] {
  return [...container.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .slice(0, -1)
      .map((cell) => cell.textContent),
  );
}

describe("DiffPanel", () => {
  const diff = buildDiff("head\n\nsame\ngone\n", "HEAD\n\nsame\n");

  it("draws the old line numbers, the new ones, and a sign beside the tint", async () => {
    const { container } = render(
      <DiffPanel diff={diff} path="agents/release-bot.toml" label="Edited" />,
    );

    expect(gutters(container)).toEqual([
      ["1", "", "−"],
      ["", "1", "+"],
      ["2", "2", " "],
      ["3", "3", " "],
      ["4", "", "−"],
      ["5", "4", " "],
    ]);
    const rows = [...container.querySelectorAll("tr")].map(
      (row) => row.className,
    );
    expect(rows).toEqual([
      "bg-destructive/10",
      "bg-success/10",
      "",
      "",
      "bg-destructive/10",
      "",
    ]);
    await expectNoAxe(container);
  });

  it("keeps a blank line as a row rather than collapsing it", async () => {
    const { container } = render(
      <DiffPanel diff={diff} path="agents/release-bot.toml" label="Edited" />,
    );
    expect(container.querySelectorAll("tr")[2]?.textContent).toBe("22  ");
    await expectNoAxe(container);
  });

  it("puts the path and the stat where a screen reader reaches them", async () => {
    const { container } = render(
      <DiffPanel diff={diff} path="agents/release-bot.toml" label="Edited" />,
    );

    expect(screen.getByTestId("diff-panel").textContent).toContain(
      "Edited: agents/release-bot.toml, +1 −2",
    );
    await expectNoAxe(container);
  });
});
