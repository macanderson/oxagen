// @vitest-environment jsdom
/**
 * key-value-editor.test.tsx — Unit tests for KeyValueEditor component.
 */

import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { KeyValueEditor } from "./key-value-editor";

afterEach(cleanup);

describe("KeyValueEditor — render", () => {
  it("renders an empty row when no value provided", () => {
    render(<KeyValueEditor onChange={vi.fn()} />);
    const keyInputs = screen.getAllByRole("textbox");
    // 2 inputs per row (key + value)
    expect(keyInputs.length).toBe(2);
  });

  it("renders rows from initial value", () => {
    render(
      <KeyValueEditor value={{ foo: "bar", baz: "qux" }} onChange={vi.fn()} />,
    );
    const inputs = screen.getAllByRole("textbox");
    expect(inputs.length).toBe(4); // 2 rows × 2 fields
  });

  it("shows key and value in inputs", () => {
    render(
      <KeyValueEditor
        value={{ apiUrl: "https://example.com" }}
        onChange={vi.fn()}
      />,
    );
    const inputs = screen.getAllByRole("textbox");
    expect(inputs[0]).toHaveValue("apiUrl");
    expect(inputs[1]).toHaveValue("https://example.com");
  });

  it("renders Add row button", () => {
    render(<KeyValueEditor onChange={vi.fn()} />);
    expect(screen.getByText("Add row")).toBeInTheDocument();
  });
});

describe("KeyValueEditor — add/remove rows", () => {
  it("adds a new empty row when Add row is clicked", async () => {
    render(<KeyValueEditor onChange={vi.fn()} />);
    const addBtn = screen.getByText("Add row");
    await userEvent.click(addBtn);
    const inputs = screen.getAllByRole("textbox");
    expect(inputs.length).toBe(4); // 2 rows × 2
  });

  it("calls onChange when a key is typed", async () => {
    const onChange = vi.fn();
    render(<KeyValueEditor onChange={onChange} />);
    const keyInput = screen.getAllByRole("textbox")[0];
    if (!keyInput) throw new Error("No key input");
    await userEvent.type(keyInput, "myKey");
    expect(onChange).toHaveBeenCalled();
    // Last call should include the typed key
    const lastCall = onChange.mock.calls.at(-1);
    if (!lastCall) throw new Error("onChange not called");
    expect(lastCall[0]).toMatchObject({ myKey: expect.anything() });
  });

  it("calls onChange when a value is typed", async () => {
    const onChange = vi.fn();
    render(<KeyValueEditor onChange={onChange} />);
    const valueInput = screen.getAllByRole("textbox")[1];
    if (!valueInput) throw new Error("No value input");
    // First set a key so the record has something
    const keyInput = screen.getAllByRole("textbox")[0];
    if (!keyInput) throw new Error("No key input");
    await userEvent.type(keyInput, "k");
    await userEvent.type(valueInput, "v");
    const lastCall = onChange.mock.calls.at(-1);
    if (!lastCall) throw new Error("onChange not called");
    expect(lastCall[0]).toMatchObject({ k: expect.stringContaining("v") });
  });

  it("disables remove button when only one row", () => {
    render(<KeyValueEditor onChange={vi.fn()} />);
    const removeBtn = screen.getByRole("button", { name: /remove row 1/i });
    expect(removeBtn).toBeDisabled();
  });

  it("enables remove button when multiple rows exist", async () => {
    render(<KeyValueEditor onChange={vi.fn()} />);
    await userEvent.click(screen.getByText("Add row"));
    const removeBtns = screen.getAllByRole("button", { name: /remove row/i });
    // Second remove button (index 1) should be enabled
    expect(removeBtns[1]).not.toBeDisabled();
  });

  it("calls onChange with the row removed when remove is clicked", async () => {
    const onChange = vi.fn();
    render(<KeyValueEditor value={{ a: "1", b: "2" }} onChange={onChange} />);
    const removeBtns = screen.getAllByRole("button", { name: /remove row/i });
    // Remove first row
    await userEvent.click(removeBtns[0]!);
    const lastCall = onChange.mock.calls.at(-1);
    if (!lastCall) throw new Error("onChange not called");
    // Should only have b
    expect(Object.keys(lastCall[0] as Record<string, string>)).toEqual(["b"]);
  });
});

describe("KeyValueEditor — disabled state", () => {
  it("disables all inputs when disabled=true", () => {
    render(<KeyValueEditor value={{ k: "v" }} onChange={vi.fn()} disabled />);
    const inputs = screen.getAllByRole("textbox");
    for (const input of inputs) {
      expect(input).toBeDisabled();
    }
  });

  it("disables Add row button when disabled=true", () => {
    render(<KeyValueEditor onChange={vi.fn()} disabled />);
    const addBtn = screen.getByText("Add row");
    expect(addBtn.closest("button")).toBeDisabled();
  });
});
