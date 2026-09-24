// @vitest-environment jsdom
// The statement editor as a person drives it: typing, the keys it takes over
// (Tab, Shift+Tab, Enter, Ctrl+F, Escape), find with its count and its steps,
// the status line and the painted layers. The pure edits (indent, newline,
// findAll, caretAt) are proven in markdown.test.ts; this proves the component
// wires them to the keys and keeps the layers in step with the text.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { StatementEditor } from "./statement-editor";

const PATH = ".oxagen/rules/ctx.scr.001-never-push-to-main.toml · statement";

function Harness({
  initial,
  base = initial,
  onChange,
}: {
  initial: string;
  base?: string;
  onChange?: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <StatementEditor
      path={PATH}
      value={value}
      base={base}
      bar={<span data-testid="bar">tokens</span>}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

function editor(initial: string, base?: string) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <Harness initial={initial} base={base} onChange={onChange} />
    </IntlProvider>,
  );
  const area = screen.getByTestId<HTMLTextAreaElement>("record-statement");
  return { user, area, onChange };
}

afterEach(cleanup);

describe("the statement editor", () => {
  it("draws the path, the unchanged state, one gutter row a line and the status line", async () => {
    editor("# Heading\n\nNever push to **main**.\n> quoted");
    const root = screen.getByTestId("record-editor");
    expect(root).toHaveAccessibleName(PATH);
    expect(screen.getByTestId("draft-state")).toHaveTextContent("unchanged");
    expect(screen.getByTestId("bar")).toBeTruthy();
    expect(screen.getByTestId("record-gutter").children).toHaveLength(4);
    expect(screen.getByTestId("record-counts")).toHaveTextContent(
      "4 lines · 43 chars",
    );
    expect(screen.getByTestId("record-grammar")).toHaveTextContent("Markdown");
    const paint = screen.getByTestId("record-paint");
    expect(paint.querySelector('[data-token="heading"]')).toHaveTextContent(
      "# Heading",
    );
    expect(paint.querySelector('[data-token="strong"]')).toBeTruthy();
    expect(paint.querySelector('[data-token="quote"]')).toBeTruthy();
    await expectNoAxe(root);
  });

  it("says modified once the draft differs from the statement in force", async () => {
    const { user, area, onChange } = editor("Never push.");
    await user.click(area);
    await user.keyboard("{End} ever");
    expect(onChange).toHaveBeenLastCalledWith("Never push. ever");
    expect(screen.getByTestId("draft-state")).toHaveTextContent("modified");
    expect(screen.getByTestId("record-counts")).toHaveTextContent(
      "1 line · 16 chars",
    );
  });

  it("indents two spaces on Tab and takes them out on Shift+Tab", async () => {
    const { user, area } = editor("abc");
    area.focus();
    area.setSelectionRange(0, 0);
    await user.keyboard("{Tab}");
    expect(area.value).toBe("  abc");
    area.setSelectionRange(0, 5);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(area.value).toBe("abc");
  });

  it("continues a numbered list on Enter with the next number", async () => {
    const { user, area } = editor("1. Freeze main");
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    await user.keyboard("{Enter}");
    expect(area.value).toBe("1. Freeze main\n2. ");
    expect(screen.getByTestId("record-caret")).toHaveTextContent("Ln 2, Col 4");
  });

  it("counts the characters a selection holds on the status line", () => {
    const { area } = editor("Never push to main.");
    area.setSelectionRange(0, 5);
    fireEvent.select(area);
    expect(screen.getByTestId("record-caret")).toHaveTextContent(
      "Ln 1, Col 1 (5 selected)",
    );
  });

  it("finds every match, steps forward and back through them, and marks the current one", async () => {
    const { user, area } = editor("Read, re-read, READ");
    area.focus();
    area.setSelectionRange(0, 0);
    // Ctrl+F moves to the find box rather than the browser's.
    await user.keyboard("{Control>}f{/Control}");
    const find = screen.getByTestId<HTMLInputElement>("record-find");
    expect(document.activeElement).toBe(find);
    await user.type(find, "read");
    const count = screen.getByTestId("record-find-count");
    expect(count).toHaveTextContent("3");
    expect(document.querySelectorAll("mark")).toHaveLength(3);
    fireEvent.keyDown(find, { key: "Enter" });
    expect(count).toHaveTextContent("1 of 3");
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(4);
    fireEvent.keyDown(find, { key: "Enter" });
    expect(count).toHaveTextContent("2 of 3");
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    expect(count).toHaveTextContent("1 of 3");
    expect(document.querySelector("mark[data-current]")).toHaveTextContent(
      "Read",
    );
    // Back past the first match wraps to the last.
    fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
    expect(count).toHaveTextContent("3 of 3");
  });

  it("wraps forward from past the last match to the first", async () => {
    const { user, area } = editor("Read, re-read, READ");
    const find = screen.getByTestId<HTMLInputElement>("record-find");
    await user.type(find, "read");
    const count = screen.getByTestId("record-find-count");
    // The caret sits after the last match, so no match starts at or after it.
    area.setSelectionRange(area.value.length, area.value.length);
    fireEvent.keyDown(find, { key: "Enter" });
    expect(count).toHaveTextContent("1 of 3");
    expect(area.selectionStart).toBe(0);
  });

  it("says 0 when nothing matches, and Escape in the find box clears it and returns to the text (negative)", async () => {
    const { user, area } = editor("Never push to main.");
    const find = screen.getByTestId<HTMLInputElement>("record-find");
    await user.type(find, "deploy");
    expect(screen.getByTestId("record-find-count")).toHaveTextContent("0");
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    // Enter with no match moves nothing.
    fireEvent.keyDown(find, { key: "Enter" });
    expect(screen.getByTestId("record-find-count")).toHaveTextContent("0");
    fireEvent.keyDown(find, { key: "Escape" });
    expect(find.value).toBe("");
    expect(screen.getByTestId("record-find-count")).toHaveTextContent("");
    expect(document.activeElement).toBe(area);
  });

  it("clears a find with Escape from the text too, and leaves Escape alone when nothing is found", async () => {
    const { user, area } = editor("main and main");
    const find = screen.getByTestId<HTMLInputElement>("record-find");
    await user.type(find, "main");
    expect(screen.getByTestId("record-find-count")).toHaveTextContent("2");
    area.focus();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(find.value).toBe("");
    // A second Escape has no find to clear and changes nothing.
    fireEvent.keyDown(area, { key: "Escape" });
    expect(area.value).toBe("main and main");
  });
});
