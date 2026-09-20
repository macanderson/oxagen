// @vitest-environment jsdom
// The code editor: the textarea is the one control and carries the label, the
// paint beneath it is hidden from assistive tech and holds the same text in
// coloured spans, both set in the mono face on the code ground, an edit
// reaches onChange with the whole draft, and the two layers share one cell
// that grows with the longest line so the frame scrolls them together. Axe
// runs on the rendered editor.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { CodeEditor } from "./code-editor";

afterEach(cleanup);

const SOURCE = '# a\nschema = "oxagen.agent/v1"\nretries = 3\n[harness]\n';

function Harness({ onChange }: { onChange: (next: string) => void }) {
  const [value, setValue] = useState(SOURCE);
  return (
    <CodeEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      language="toml"
      label="agents/release-bot.toml"
    />
  );
}

describe("CodeEditor", () => {
  it("labels the textarea, paints the same text in coloured spans, and sets both in the mono face on the code ground", async () => {
    const { container } = render(<Harness onChange={vi.fn()} />);
    const editor = screen.getByRole("textbox", {
      name: "agents/release-bot.toml",
    });
    expect(editor).toHaveValue(SOURCE);
    expect(editor).toHaveAttribute("wrap", "off");
    expect(editor.className).toContain("font-mono");
    expect(editor.className).toContain("text-transparent");

    const frame = screen.getByTestId("code-editor");
    expect(frame.className).toContain("bg-code-bg");
    expect(frame.className).toContain("font-mono");

    const paint = screen.getByTestId("code-paint");
    expect(paint).toHaveAttribute("aria-hidden", "true");
    expect(paint.textContent).toBe(`${SOURCE}\n`);
    const spans = [...paint.querySelectorAll("span")].map((s) => [
      s.className,
      s.textContent,
    ]);
    expect(spans).toEqual([
      ["text-code-comment", "# a"],
      ["text-code-key", "schema"],
      ["text-code-punct", "="],
      ["text-code-string", '"oxagen.agent/v1"'],
      ["text-code-key", "retries"],
      ["text-code-punct", "="],
      ["text-code-number", "3"],
      ["font-medium text-code-table", "[harness]"],
    ]);
    // Five lines, so five line numbers.
    expect(container.querySelector("pre")?.textContent).toBe("1\n2\n3\n4\n5");
    await expectNoAxe(container);
  });

  it("hands every edit to onChange and repaints from the new draft", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const editor = screen.getByRole("textbox", {
      name: "agents/release-bot.toml",
    });
    fireEvent.change(editor, { target: { value: "live = true" } });
    expect(onChange).toHaveBeenCalledWith("live = true");
    expect(editor).toHaveValue("live = true");
    expect(
      [...screen.getByTestId("code-paint").querySelectorAll("span")].map(
        (s) => s.textContent,
      ),
    ).toEqual(["live", "=", "true"]);
    expect(editor).toHaveAttribute("rows", "16");
  });

  it("sizes the shared cell to the painted line, not the frame, so a long line scrolls the paint and the textarea as one", () => {
    const long = `# ${"x".repeat(400)}`;
    render(<Harness onChange={vi.fn()} />);
    const editor = screen.getByRole("textbox", {
      name: "agents/release-bot.toml",
    });
    fireEvent.change(editor, { target: { value: long } });
    const paint = screen.getByTestId("code-paint");
    expect(paint.textContent).toBe(`${long}\n`);

    // jsdom lays nothing out, so the contract is asserted on the classes that
    // set it: the cell holding both layers is at least its content's width
    // (`min-w-max`) rather than pinned to the frame (`min-w-0`), the textarea
    // fills that cell and never scrolls on its own, and the frame is the one
    // scroll container. With `min-w-0` the paint overflowed the cell while the
    // textarea scrolled inside it, and the caret left its glyph.
    const cell = paint.parentElement;
    if (cell === null) throw new Error("the paint sits in the shared cell");
    expect(cell.className).toContain("grid");
    expect(cell.className).toContain("min-w-max");
    expect(cell.className).not.toContain("min-w-0");
    expect(editor.parentElement).toBe(cell);
    expect(editor.className).toContain("w-full");
    expect(editor.className).toContain("overflow-hidden");
    expect(editor.className).toContain("whitespace-pre");
    expect(paint.className).toContain("whitespace-pre");
    expect(screen.getByTestId("code-editor").className).toContain(
      "overflow-auto",
    );
  });
});
