// @vitest-environment jsdom
/**
 * confirm-destructive-inline.test.tsx
 *
 * Render + interaction tests for ConfirmDestructiveInline:
 *   - Renders title and description in idle state
 *   - Confirm button transitions to "confirmed" state
 *   - Deny button transitions to "denied" state
 *   - Custom labels respected
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConfirmDestructiveInline from "./confirm-destructive-inline";

afterEach(cleanup);

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    type,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    type?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      data-variant={variant}
    >
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    AlertTriangle: vi.fn(() => <span data-testid="icon-alert" />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
    XCircle: vi.fn(() => <span data-testid="icon-x-circle" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("ConfirmDestructiveInline", () => {
  it("renders default title 'Are you sure?' in idle state", () => {
    render(<ConfirmDestructiveInline />);
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  it("renders custom title", () => {
    render(<ConfirmDestructiveInline title="Delete this record?" />);
    expect(screen.getByText("Delete this record?")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(
      <ConfirmDestructiveInline description="This action cannot be undone." />,
    );
    expect(
      screen.getByText("This action cannot be undone."),
    ).toBeInTheDocument();
  });

  it("renders default Confirm and Cancel buttons", () => {
    render(<ConfirmDestructiveInline />);
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("renders custom confirmLabel and denyLabel", () => {
    render(
      <ConfirmDestructiveInline
        confirmLabel="Yes, delete"
        denyLabel="No, keep"
      />,
    );
    expect(screen.getByText("Yes, delete")).toBeInTheDocument();
    expect(screen.getByText("No, keep")).toBeInTheDocument();
  });

  it("transitions to confirmed state when Confirm is clicked", async () => {
    render(<ConfirmDestructiveInline />);
    await userEvent.click(screen.getByText("Confirm"));
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
  });

  it("transitions to denied state when Cancel is clicked", async () => {
    render(<ConfirmDestructiveInline />);
    await userEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Are you sure?")).not.toBeInTheDocument();
  });

  it("uses alertdialog role in idle state", () => {
    render(<ConfirmDestructiveInline />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("shows 'Confirmed' icon in confirmed state", async () => {
    render(<ConfirmDestructiveInline />);
    await userEvent.click(screen.getByText("Confirm"));
    expect(screen.getByTestId("icon-check")).toBeInTheDocument();
  });

  it("shows 'XCircle' icon in denied state", async () => {
    render(<ConfirmDestructiveInline />);
    await userEvent.click(screen.getByText("Cancel"));
    expect(screen.getByTestId("icon-x-circle")).toBeInTheDocument();
  });
});
