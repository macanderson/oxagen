// @vitest-environment jsdom
// The two read-only code surfaces a transcript draws on. CodePanel numbers
// every line from the start line it is given, paints it with the house code
// tokens, keeps a blank line as a row rather than dropping it, and shows a
// long pane to its budget behind one control that says how much is still
// folded. DiffPanel draws both gutters, a sign beside the tint so the change
// survives greyscale, and the path and the stat where a screen reader reaches
// them. Axe runs on the state each test ends in (INV-26).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiff } from "@/shared/line-diff";
import { expectNoAxe } from "@/test/expect-no-axe";
import { CodePanel, DiffPanel } from "./code-panel";

afterEach(cleanup);

/** The numbers down the left of a panel, in the order they are drawn. */
function gutters(container: Element): string[][] {
  return [...container.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll("td")]
      .slice(0, -1)
      .map((cell) => cell.textContent),
  );
}

describe("CodePanel", () => {
  it("numbers every line from the start line and paints it in the house tokens", async () => {
    const { container } = render(
      <CodePanel
        code={"ls -la # note\necho hi\n"}
        language="shell"
        startLine={7}
        expandLabel="Show the file"
      />,
    );

    expect(gutters(container)).toEqual([["7"], ["8"]]);
    const spans = [...container.querySelectorAll("span")].map((span) => [
      span.className,
      span.textContent,
    ]);
    expect(spans).toEqual([
      ["font-medium text-code-table", "ls"],
      ["text-code-key", "-la"],
      ["text-code-comment", "# note"],
      ["font-medium text-code-table", "echo"],
    ]);
    await expectNoAxe(container);
  });

  it("draws a heading only when it is given one", async () => {
    const { container, rerender } = render(
      <CodePanel code="ls -la" expandLabel="Show the command" />,
    );
    expect(container.textContent).toBe("1ls -la");

    rerender(
      <CodePanel code="ls -la" label="ran" expandLabel="Show the command" />,
    );
    expect(container.textContent).toBe("ran1ls -la");
    await expectNoAxe(container);
  });

  it("keeps a blank line as a row and does not number a trailing newline", async () => {
    const { container } = render(
      <CodePanel code={"head\n\ntail\n"} expandLabel="Show the file" />,
    );
    expect(gutters(container)).toEqual([["1"], ["2"], ["3"]]);
    expect(container.querySelectorAll("tr")[1]?.textContent).toBe("2 ");
    await expectNoAxe(container);
  });

  it("shows a pane that fits its budget whole, with nothing to click", async () => {
    const { container } = render(
      <CodePanel
        code={"one\ntwo"}
        preview={5}
        expandLabel="Show the command"
      />,
    );
    expect(container.querySelectorAll("tr")).toHaveLength(2);
    expect(screen.queryByTestId("code-panel-more")).toBeNull();
    await expectNoAxe(container);
  });

  it("folds a pane past its budget and says how many lines are still hidden", async () => {
    const code = Array.from(
      { length: 9 },
      (_, i) => `line ${String(i + 1)}`,
    ).join("\n");
    const { container } = render(
      <CodePanel code={code} preview={4} expandLabel="Show the file" />,
    );

    const more = screen.getByTestId("code-panel-more");
    expect(container.querySelectorAll("tr")).toHaveLength(4);
    expect(more).toHaveTextContent("Show the file (5 more)");
    expect(more).toHaveAttribute("aria-expanded", "false");
    await expectNoAxe(container);
  });

  it("unfolds the rest when the reader asks, and keeps the control", async () => {
    const code = Array.from(
      { length: 9 },
      (_, i) => `line ${String(i + 1)}`,
    ).join("\n");
    const { container } = render(
      <CodePanel code={code} preview={4} expandLabel="Show the file" />,
    );

    fireEvent.click(screen.getByTestId("code-panel-more"));

    const more = screen.getByTestId("code-panel-more");
    expect(container.querySelectorAll("tr")).toHaveLength(9);
    expect(more).toHaveTextContent("Show the file");
    expect(more.textContent).not.toContain("more)");
    expect(more).toHaveAttribute("aria-expanded", "true");
    await expectNoAxe(container);
  });
});

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
