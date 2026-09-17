// @vitest-environment jsdom
/**
 * consent-card.test.tsx
 *
 * Render + interaction tests for ConsentCard:
 *   - Shows the tool name, server id, and capability
 *   - Shows Allow/Deny buttons when not resolved and not expired
 *   - Calls onResolved with (approvalId, decision, grantAllTools)
 *   - Passes grantAllTools=true when the "trust every tool" box is checked
 *   - Shows the resolved status / Expired status / error message
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConsentCard } from "./consent-card";

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

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    disabled,
  }: {
    checked?: boolean;
    onCheckedChange?: (v: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      type="checkbox"
      aria-label="trust-all"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Check: vi.fn(() => <span data-testid="icon-check" />),
    ShieldCheck: vi.fn(() => <span data-testid="icon-shield" />),
    Plug: vi.fn(() => <span data-testid="icon-plug" />),
    X: vi.fn(() => <span data-testid="icon-x" />),
  };
});

const FUTURE = new Date(Date.now() + 60_000).toISOString();

const baseProps = {
  approvalId: "apr-c1",
  capability: "mcp.srv_1.list_prs",
  serverId: "srv_1",
  toolName: "list_prs",
  inputPreview: { repo: "oxagen" },
  expiresAt: FUTURE,
};

describe("ConsentCard", () => {
  it("renders the tool name and server id", () => {
    render(<ConsentCard {...baseProps} />);
    // tool name appears in both the header label and the descriptive sentence.
    expect(screen.getAllByText("list_prs").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("srv_1")).toBeInTheDocument();
  });

  it("renders the sample input as a typed tree, never raw JSON", () => {
    const { container } = render(<ConsentCard {...baseProps} />);
    expect(screen.getByText("Sample input")).toBeInTheDocument();
    expect(screen.getByText("Repo")).toBeInTheDocument(); // humanized key
    expect(screen.getByText("oxagen")).toBeInTheDocument(); // value
    expect(container.textContent ?? "").not.toContain('"repo"');
  });

  it("renders Allow and Deny buttons when unresolved", () => {
    render(<ConsentCard {...baseProps} />);
    expect(screen.getByText("Allow")).toBeInTheDocument();
    expect(screen.getByText("Deny")).toBeInTheDocument();
  });

  it("calls onResolved with (approvalId, 'granted', false) on Allow click", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: true });
    render(<ConsentCard {...baseProps} onResolved={onResolved} />);
    await userEvent.click(screen.getByText("Allow"));
    expect(onResolved).toHaveBeenCalledWith("apr-c1", "granted", false);
  });

  it("passes grantAllTools=true when the trust-all box is checked", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: true });
    render(<ConsentCard {...baseProps} onResolved={onResolved} />);
    await userEvent.click(screen.getByLabelText("trust-all"));
    await userEvent.click(screen.getByText("Allow"));
    expect(onResolved).toHaveBeenCalledWith("apr-c1", "granted", true);
  });

  it("denies with grantAllTools=false even if the box is checked", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: true });
    render(<ConsentCard {...baseProps} onResolved={onResolved} />);
    await userEvent.click(screen.getByLabelText("trust-all"));
    await userEvent.click(screen.getByText("Deny"));
    expect(onResolved).toHaveBeenCalledWith("apr-c1", "denied", false);
  });

  it("shows a success-toned granted status when resolution='granted'", () => {
    render(<ConsentCard {...baseProps} resolution="granted" />);
    const status = screen.getByText("granted");
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-success");
    expect(screen.queryByText("Allow")).not.toBeInTheDocument();
  });

  it("shows the muted Expired status when expiresAt is in the past and unresolved", () => {
    const PAST = new Date(Date.now() - 10_000).toISOString();
    render(<ConsentCard {...baseProps} expiresAt={PAST} />);
    const expired = screen.getByText("Expired");
    expect(expired).toBeInTheDocument();
    expect(expired.className).toContain("text-muted-foreground");
  });

  it("shows an error message when onResolved returns not-ok", async () => {
    const onResolved = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Server error" });
    render(<ConsentCard {...baseProps} onResolved={onResolved} />);
    await userEvent.click(screen.getByText("Allow"));
    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });
  });

  it("shows the default error when onResolved returns not-ok without text", async () => {
    const onResolved = vi.fn().mockResolvedValue({ ok: false });
    render(<ConsentCard {...baseProps} onResolved={onResolved} />);
    await userEvent.click(screen.getByText("Deny"));
    await waitFor(() => {
      expect(screen.getByText("Failed to resolve consent")).toBeInTheDocument();
    });
  });

  it("is a no-op when onResolved is not provided", async () => {
    render(<ConsentCard {...baseProps} />);
    await userEvent.click(screen.getByText("Allow"));
    // No throw expected.
  });
});
