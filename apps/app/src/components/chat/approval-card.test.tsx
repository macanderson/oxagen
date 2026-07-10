// @vitest-environment jsdom
/**
 * approval-card.test.tsx
 *
 * Render + interaction tests for ApprovalCard:
 *   - Shows capability name and risk indicator
 *   - Shows approve/deny buttons when not resolved and not expired
 *   - Shows the resolved status text when resolution is set
 *   - Calls onResolved with correct arguments
 *   - Shows error message when resolution fails
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalCard } from "./approval-card";

afterEach(cleanup);

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    size,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    size?: string;
    variant?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      data-size={size}
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
    Check: vi.fn(() => <span data-testid="icon-check" />),
    ShieldAlert: vi.fn(() => <span data-testid="icon-shield" />),
    X: vi.fn(() => <span data-testid="icon-x" />),
  };
});

vi.mock("./risk-badge", () => ({
  RiskBadge: ({ risk }: { risk: string }) => <span data-testid="risk-badge">{risk}</span>,
}));

// future date — ensures countdown doesn't immediately expire
const FUTURE = new Date(Date.now() + 60_000).toISOString();

describe("ApprovalCard", () => {
  it("renders capability name", () => {
    render(
      <ApprovalCard
        approvalId="a1"
        capability="files.delete"
        inputPreview={{ path: "/tmp/test" }}
        riskLevel="high"
        expiresAt={FUTURE}
      />,
    );
    expect(screen.getByText("files.delete")).toBeInTheDocument();
  });

  it("renders the proposed input as a typed tree, never raw JSON", () => {
    const { container } = render(
      <ApprovalCard
        approvalId="a1"
        capability="files.delete"
        inputPreview={{ path: "/tmp/test" }}
        riskLevel="high"
        expiresAt={FUTURE}
      />,
    );
    expect(screen.getByText("Proposed input")).toBeInTheDocument();
    expect(screen.getByText("Path")).toBeInTheDocument(); // humanized key
    expect(screen.getByText("/tmp/test")).toBeInTheDocument(); // value
    expect(container.textContent ?? "").not.toContain('"path"');
  });

  it("renders risk badge", () => {
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="medium"
        expiresAt={FUTURE}
      />,
    );
    expect(screen.getByTestId("risk-badge")).toHaveTextContent("medium");
  });

  it("renders Approve and Deny buttons when not resolved and not expired", () => {
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
      />,
    );
    expect(screen.getByText("Approve")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("shows a success-toned approved status when resolution='approved'", () => {
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
        resolution="approved"
      />,
    );
    const status = screen.getByText("approved");
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-success");
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
  });

  it("shows a destructive-toned denied status when resolution='denied'", () => {
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
        resolution="denied"
      />,
    );
    const status = screen.getByText("denied");
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-destructive");
  });

  it("calls onResolved with approvalId and 'approved' on Approve click", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: true });
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
        onResolved={onResolved}
      />,
    );
    await userEvent.click(screen.getByText("Approve"));
    expect(onResolved).toHaveBeenCalledWith("a1", "approved");
  });

  it("calls onResolved with approvalId and 'denied' on Deny click", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: true });
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
        onResolved={onResolved}
      />,
    );
    await userEvent.click(screen.getByText("Deny"));
    expect(onResolved).toHaveBeenCalledWith("a1", "denied");
  });

  it("shows error message when onResolved returns not-ok", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: false, error: "Server error" });
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
        onResolved={onResolved}
      />,
    );
    await userEvent.click(screen.getByText("Approve"));
    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });
  });

  it("shows default error message when onResolved returns not-ok without error text", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: false });
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
        onResolved={onResolved}
      />,
    );
    await userEvent.click(screen.getByText("Deny"));
    await waitFor(() => {
      expect(screen.getByText("Failed to resolve approval")).toBeInTheDocument();
    });
  });

  it("shows the Expired status when expiresAt is in the past and no resolution", () => {
    const PAST = new Date(Date.now() - 10_000).toISOString();
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={PAST}
      />,
    );
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("does not call onResolved when it is not provided", async () => {
    render(
      <ApprovalCard
        approvalId="a1"
        capability="search"
        inputPreview={{}}
        riskLevel="low"
        expiresAt={FUTURE}
      />,
    );
    // Clicking approve without onResolved should be a no-op
    await userEvent.click(screen.getByText("Approve"));
    // No error expected
  });
});
