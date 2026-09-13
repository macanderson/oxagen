// @vitest-environment jsdom
/**
 * delete-confirm-dialog.test.tsx — render + interaction tests for DeleteConfirmDialog.
 *
 * Covers:
 *   - Closed state: does not render when open=false
 *   - Open state: renders title, description, Cancel + Delete buttons
 *   - Custom confirmLabel renders on the confirm button
 *   - pending=true: both buttons disabled, confirm shows "Deleting…"
 *   - Cancel calls onOpenChange(false)
 *   - Confirm calls onConfirm
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";

afterEach(cleanup);

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  title: "Delete conversation?",
  description: "This action cannot be undone.",
  onConfirm: vi.fn(),
};

describe("DeleteConfirmDialog — closed", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <DeleteConfirmDialog {...defaultProps} open={false} />,
    );
    expect(screen.queryByText("Delete conversation?")).not.toBeInTheDocument();
    expect(container.firstChild).toBeDefined(); // wrapper may exist but dialog body absent
  });
});

describe("DeleteConfirmDialog — open", () => {
  it("renders the title", () => {
    render(<DeleteConfirmDialog {...defaultProps} />);
    expect(screen.getByText("Delete conversation?")).toBeInTheDocument();
  });

  it("renders the description", () => {
    render(<DeleteConfirmDialog {...defaultProps} />);
    expect(
      screen.getByText("This action cannot be undone."),
    ).toBeInTheDocument();
  });

  it("renders Cancel and Delete buttons", () => {
    render(<DeleteConfirmDialog {...defaultProps} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });

  it("uses custom confirmLabel", () => {
    render(<DeleteConfirmDialog {...defaultProps} confirmLabel="Delete all" />);
    expect(
      screen.getByRole("button", { name: /delete all/i }),
    ).toBeInTheDocument();
  });

  it("Cancel calls onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(
      <DeleteConfirmDialog {...defaultProps} onOpenChange={onOpenChange} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Confirm calls onConfirm", async () => {
    const onConfirm = vi.fn();
    render(<DeleteConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onConfirm).toHaveBeenCalled();
  });
});

describe("DeleteConfirmDialog — pending state", () => {
  it("shows 'Deleting…' on confirm button when pending", () => {
    render(<DeleteConfirmDialog {...defaultProps} pending />);
    expect(screen.getByText("Deleting…")).toBeInTheDocument();
  });

  it("confirm button is disabled when pending", () => {
    render(<DeleteConfirmDialog {...defaultProps} pending />);
    const confirmBtn = screen.getByText("Deleting…").closest("button");
    expect(confirmBtn).toBeDisabled();
  });

  it("cancel button is disabled when pending", () => {
    render(<DeleteConfirmDialog {...defaultProps} pending />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
  });
});
