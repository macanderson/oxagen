// @vitest-environment jsdom
/**
 * forgot-password-form.test.tsx — component tests for ForgotPasswordForm.
 *
 * Covers:
 *   (a) Initial render — email input and submit button present.
 *   (b) Happy path — calls requestResetAction, shows confirmation message.
 *   (c) Error path — shows error message from action.
 *   (d) Submitting state — button is disabled during submission.
 *   (e) "Send another link" — resets back to idle form.
 *
 * Mock seam: ./actions (requestResetAction).
 */

import * as React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockRequestResetAction } = vi.hoisted(() => ({
  mockRequestResetAction: vi.fn(),
}));

vi.mock("./actions", () => ({
  requestResetAction: mockRequestResetAction,
}));

// Mock UI primitives that rely on provider trees not present in jsdom tests.
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    variant?: string;
    size?: string;
    className?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{children}</label>,
}));

import { ForgotPasswordForm } from "./forgot-password-form";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ForgotPasswordForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // (a) Initial render
  // ---------------------------------------------------------------------------

  it("renders the email input and submit button", () => {
    render(<ForgotPasswordForm />);

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /send reset link/i }),
    ).toBeInTheDocument();
  });

  it("email input has type=email and is enabled initially", () => {
    render(<ForgotPasswordForm />);
    const input = screen.getByLabelText(/email/i);
    expect(input).toHaveAttribute("type", "email");
    expect(input).not.toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // (b) Happy path — confirmation shown
  // ---------------------------------------------------------------------------

  it("shows confirmation message after successful action", async () => {
    const user = userEvent.setup();
    mockRequestResetAction.mockResolvedValue({ ok: true });

    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(mockRequestResetAction).toHaveBeenCalledOnce();
    expect(mockRequestResetAction).toHaveBeenCalledWith({
      email: "user@example.com",
    });
  });

  // ---------------------------------------------------------------------------
  // (c) Error path
  // ---------------------------------------------------------------------------

  it("shows error message when action returns ok:false", async () => {
    const user = userEvent.setup();
    mockRequestResetAction.mockResolvedValue({
      ok: false,
      error: "Please enter a valid email address.",
    });

    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText(/email/i), "bad-email");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please enter a valid email address.",
    );
    // Form should still be visible (not replaced by confirmation)
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (d) Submitting state
  // ---------------------------------------------------------------------------

  it("disables the submit button while submitting", async () => {
    const user = userEvent.setup();
    let resolve!: (val: { ok: boolean }) => void;
    mockRequestResetAction.mockReturnValue(
      new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      }),
    );

    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    // During submission the button text changes to "Sending…"
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();
    });

    // Resolve the promise and wait for confirmation
    resolve({ ok: true });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // (e) "Send another link" resets the form
  // ---------------------------------------------------------------------------

  it("returns to the idle form when Send another link is clicked", async () => {
    const user = userEvent.setup();
    mockRequestResetAction.mockResolvedValue({ ok: true });

    render(<ForgotPasswordForm />);

    await user.type(screen.getByLabelText(/email/i), "user@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    // Click "Send another link"
    await user.click(
      screen.getByRole("button", { name: /send another link/i }),
    );

    // Form should be restored
    await waitFor(() => {
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /send reset link/i }),
    ).toBeInTheDocument();
  });
});
