// @vitest-environment jsdom
/**
 * revoke-own-session-button.test.tsx — component tests for RevokeOwnSessionButton.
 *
 * Covers:
 *   (a) Initial render — Revoke button shown.
 *   (b) First click — enters confirming state (Confirm + Cancel buttons).
 *   (c) Cancel — returns to idle.
 *   (d) Confirm revoke — happy path, action called, component waits (page revalidates externally).
 *   (e) Confirm revoke — action returns error, error UI shown with Dismiss button.
 *   (f) Dismiss error — returns to idle.
 *
 * Mock seam: ../actions (revokeOwnSessionAction), lucide-react (CircleSlash).
 */

import * as React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockRevokeOwnSessionAction } = vi.hoisted(() => ({
  mockRevokeOwnSessionAction: vi.fn(),
}));

vi.mock("../actions", () => ({
  revokeOwnSessionAction: mockRevokeOwnSessionAction,
}));

// Lucide icon — rendered as a plain span in tests
vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    CircleSlash: vi.fn(() => (
      <span data-testid="circle-slash-icon" aria-hidden="true" />
    )),
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    variant: _v,
    size: _s,
    className: _c,
    title,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    variant?: string;
    size?: string;
    className?: string;
    title?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  ),
}));

import { RevokeOwnSessionButton } from "./revoke-own-session-button";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RevokeOwnSessionButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // (a) Initial render
  // ---------------------------------------------------------------------------

  it("renders the initial Revoke button", () => {
    render(<RevokeOwnSessionButton sessionId="sess-123" />);
    expect(screen.getByRole("button", { name: /revoke/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (b) First click — confirming state
  // ---------------------------------------------------------------------------

  it("shows Confirm and Cancel buttons after first click", async () => {
    const user = userEvent.setup({ delay: null });
    render(<RevokeOwnSessionButton sessionId="sess-123" />);

    await user.click(screen.getByRole("button", { name: /revoke/i }));

    expect(
      screen.getByRole("button", { name: /confirm/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    // Original revoke button should be gone
    expect(screen.queryByTitle(/revoke this session/i)).not.toBeInTheDocument();
  });

  it("shows 'Revoke?' text in confirming state", async () => {
    const user = userEvent.setup({ delay: null });
    render(<RevokeOwnSessionButton sessionId="sess-123" />);

    await user.click(screen.getByRole("button", { name: /revoke/i }));

    expect(screen.getByText(/revoke\?/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (c) Cancel — returns to idle
  // ---------------------------------------------------------------------------

  it("returns to idle when Cancel is clicked in confirming state", async () => {
    const user = userEvent.setup({ delay: null });
    render(<RevokeOwnSessionButton sessionId="sess-123" />);

    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.getByTitle(/revoke this session/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /confirm/i }),
    ).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (d) Confirm revoke — happy path
  // ---------------------------------------------------------------------------

  it("calls revokeOwnSessionAction with the sessionId when Confirm is clicked", async () => {
    const user = userEvent.setup({ delay: null });
    mockRevokeOwnSessionAction.mockResolvedValue({ ok: true });

    render(<RevokeOwnSessionButton sessionId="sess-abc" />);

    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(mockRevokeOwnSessionAction).toHaveBeenCalledOnce();
    });

    expect(mockRevokeOwnSessionAction).toHaveBeenCalledWith({
      sessionId: "sess-abc",
    });
  });

  it("does not call revokeOwnSessionAction on the first Revoke click (guard)", async () => {
    const user = userEvent.setup({ delay: null });
    render(<RevokeOwnSessionButton sessionId="sess-123" />);

    await user.click(screen.getByRole("button", { name: /revoke/i }));

    expect(mockRevokeOwnSessionAction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (e) Error from action
  // ---------------------------------------------------------------------------

  it("shows error message and Dismiss button when action returns ok:false", async () => {
    const user = userEvent.setup({ delay: null });
    mockRevokeOwnSessionAction.mockResolvedValue({
      ok: false,
      error: "Failed to revoke session.",
    });

    render(<RevokeOwnSessionButton sessionId="sess-err" />);

    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /dismiss/i }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/failed to revoke session/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (f) Dismiss error
  // ---------------------------------------------------------------------------

  it("returns to idle when Dismiss is clicked after an error", async () => {
    const user = userEvent.setup({ delay: null });
    mockRevokeOwnSessionAction.mockResolvedValue({
      ok: false,
      error: "Failed to revoke session.",
    });

    render(<RevokeOwnSessionButton sessionId="sess-err" />);

    await user.click(screen.getByRole("button", { name: /revoke/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /dismiss/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    await waitFor(() => {
      expect(screen.getByTitle(/revoke this session/i)).toBeInTheDocument();
    });
  });
});
