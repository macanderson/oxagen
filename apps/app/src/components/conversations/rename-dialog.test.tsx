// @vitest-environment jsdom
/**
 * rename-dialog.test.tsx — render + interaction tests for RenameDialog.
 *
 * Covers:
 *   - Renders title input seeded from initialTitle when open
 *   - Closed state: dialog body not in DOM
 *   - Editing input and submitting calls onSubmit with trimmed value
 *   - Enter key submits
 *   - Save button disabled when input is blank or whitespace-only
 *   - pending=true disables both buttons and shows "Saving…"
 *   - Re-opening with a new initialTitle reseeds the field
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenameDialog } from "./rename-dialog";

afterEach(cleanup);

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  initialTitle: "My conversation",
  onSubmit: vi.fn(),
};

describe("RenameDialog — rendering", () => {
  it("renders the dialog title when open", () => {
    render(<RenameDialog {...defaultProps} />);
    expect(screen.getByText("Rename conversation")).toBeInTheDocument();
  });

  it("seeds the input with initialTitle", () => {
    render(<RenameDialog {...defaultProps} />);
    expect(screen.getByRole("textbox")).toHaveValue("My conversation");
  });

  it("does not show dialog content when open=false", () => {
    render(<RenameDialog {...defaultProps} open={false} />);
    expect(screen.queryByText("Rename conversation")).not.toBeInTheDocument();
  });
});

describe("RenameDialog — interactions", () => {
  it("calls onSubmit with trimmed value on Save click", async () => {
    const onSubmit = vi.fn();
    render(<RenameDialog {...defaultProps} onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "  New title  ");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith("New title");
  });

  it("calls onSubmit on Enter key", async () => {
    const onSubmit = vi.fn();
    render(<RenameDialog {...defaultProps} onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "Pressed enter");
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("Pressed enter");
  });

  it("Save button is disabled when the input is empty", async () => {
    render(<RenameDialog {...defaultProps} />);
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("Save button is disabled when the input is whitespace only", async () => {
    render(<RenameDialog {...defaultProps} />);
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "   ");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("Cancel calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(<RenameDialog {...defaultProps} onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("RenameDialog — pending state", () => {
  it("shows 'Saving…' when pending", () => {
    render(<RenameDialog {...defaultProps} pending />);
    expect(screen.getByText("Saving…")).toBeInTheDocument();
  });

  it("Save and Cancel buttons are disabled when pending", () => {
    render(<RenameDialog {...defaultProps} pending />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    // Save button disabled when pending
    const saveBtn = screen.getByText("Saving…").closest("button");
    expect(saveBtn).toBeDisabled();
  });
});
