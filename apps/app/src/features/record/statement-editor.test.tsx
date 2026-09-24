// @vitest-environment jsdom
// The statement editor on its own, driven by the keys a person uses: Find
// opened from the statement, stepped forward and back through its matches
// with wrap-around, and cleared with Escape from either box; Enter that
// continues a list, and a modified Enter that does not; outdent across lines;
// and the selection count in the status line.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { IntlProvider } from "@/test/intl";
import { indent, newline, StatementEditor } from "./statement-editor";

const STATEMENT = "Run the tests. Then run the linter.\nRun it again.";

function Harness({ initial = STATEMENT }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <IntlProvider>
      <StatementEditor
        path=".oxagen/rules/ctx.scr.001.toml · statement"
        value={value}
        base={initial}
        onChange={setValue}
        bar={null}
      />
    </IntlProvider>
  );
}

function editor(initial?: string) {
  const user = userEvent.setup();
  render(<Harness initial={initial} />);
  return {
    user,
    area: screen.getByTestId<HTMLTextAreaElement>("record-statement"),
    find: screen.getByTestId<HTMLInputElement>("record-find"),
    count: () => screen.getByTestId("record-find-count").textContent,
  };
}

afterEach(cleanup);

describe("Find", () => {
  it("opens from the statement with Ctrl+F", async () => {
    const { user, area, find } = editor();
    area.focus();
    await user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(find);
  });

  it("steps forward through every match with Enter and wraps to the first", async () => {
    const { user, area, find, count } = editor();
    await user.click(find);
    await user.keyboard("run");
    expect(count()).toBe("3");
    // The first match starts the text, so no text precedes its mark.
    const marks = document.querySelectorAll("mark");
    expect(marks).toHaveLength(3);
    area.setSelectionRange(0, 0);
    find.focus();
    await user.keyboard("{Enter}");
    expect(count()).toBe("1 of 3");
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(3);
    expect(document.querySelector("mark[data-current]")?.textContent).toBe(
      "Run",
    );
    find.focus();
    await user.keyboard("{Enter}");
    expect(count()).toBe("2 of 3");
    find.focus();
    await user.keyboard("{Enter}");
    expect(count()).toBe("3 of 3");
    find.focus();
    await user.keyboard("{Enter}");
    expect(count()).toBe("1 of 3");
  });

  it("steps back with Shift+Enter, wrapping from the first match to the last", async () => {
    const { user, area, find, count } = editor();
    await user.click(find);
    await user.keyboard("run");
    area.setSelectionRange(0, 0);
    find.focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(count()).toBe("3 of 3");
    expect(area.selectionStart).toBe(STATEMENT.lastIndexOf("Run"));
    find.focus();
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(count()).toBe("2 of 3");
  });

  it("does nothing on Enter when nothing matches (negative)", async () => {
    const { user, area, find, count } = editor();
    await user.click(find);
    await user.keyboard("zzz");
    await user.keyboard("{Enter}");
    expect(count()).toBe("0");
    expect(document.activeElement).toBe(find);
    expect(area.value).toBe(STATEMENT);
  });

  it("clears on Escape in the find box and returns to the statement", async () => {
    const { user, area, find, count } = editor();
    await user.click(find);
    await user.keyboard("run");
    await user.keyboard("{Escape}");
    expect(find.value).toBe("");
    expect(count()).toBe("");
    expect(document.activeElement).toBe(area);
  });

  it("clears on Escape in the statement while a query is set, and leaves Escape alone otherwise", async () => {
    const { user, area, find } = editor();
    await user.click(find);
    await user.keyboard("run");
    area.focus();
    await user.keyboard("{Escape}");
    expect(find.value).toBe("");
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    await user.keyboard("{Escape}");
    expect(area.value).toBe(STATEMENT);
  });
});

describe("editing keys", () => {
  it("continues a numbered list on Enter with the next number", async () => {
    const { user, area } = editor("1. Freeze main");
    area.focus();
    area.setSelectionRange(14, 14);
    await user.keyboard("{Enter}");
    expect(area.value).toBe("1. Freeze main\n2. ");
    expect(screen.getByTestId("draft-state")).toHaveTextContent("modified");
    expect(screen.getByTestId("record-gutter").children).toHaveLength(2);
  });

  it("leaves a modified Enter to the browser rather than inserting a line (negative)", async () => {
    const { user, area } = editor("1. Freeze main");
    area.focus();
    area.setSelectionRange(14, 14);
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(area.value).toBe("1. Freeze main");
  });

  it("says how much is selected in the status line", () => {
    const { area } = editor();
    area.focus();
    area.setSelectionRange(4, 13);
    fireEvent.select(area);
    expect(screen.getByTestId("record-caret").textContent).toBe(
      "Ln 1, Col 5 (9 selected)",
    );
  });
});

describe("indent and newline", () => {
  it("outdents every line of a selection that runs to the end of the text", () => {
    const value = "  one\n  two";
    expect(indent(value, 0, value.length, true)).toEqual({
      value: "one\ntwo",
      start: 0,
      end: 7,
    });
  });

  it("indents every line of a multi-line selection", () => {
    expect(indent("a\nb\nc", 0, 3, false)).toEqual({
      value: "  a\n  b\nc",
      start: 0,
      end: 7,
    });
  });

  it("keeps a bullet and the indent of the line it continues", () => {
    expect(newline("  - item", 8, 8)).toEqual({
      value: "  - item\n  - ",
      start: 13,
      end: 13,
    });
    expect(newline("    plain", 9, 9).value).toBe("    plain\n    ");
  });
});
