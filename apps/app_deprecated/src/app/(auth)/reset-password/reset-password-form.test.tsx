// @vitest-environment jsdom
/**
 * reset-password-form.test.tsx — component tests for ResetPasswordForm.
 *
 * Covers:
 *   (a) Render with valid token — shows password fields and submit button.
 *   (b) Render with missing/empty token — immediately shows invalid-token UI.
 *   (c) Success path — action succeeds, success status shown.
 *   (d) Invalid/expired token error — shows link back to /forgot-password.
 *   (e) Generic error — shows error message in the form.
 *   (f) Submitting state — button disabled while submitting.
 *
 * Mock seam: ./actions (resetPasswordAction), next/navigation (useRouter),
 *            next/link (Link).
 */

import * as React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockResetPasswordAction, mockRouterPush } = vi.hoisted(() => ({
  mockResetPasswordAction: vi.fn(),
  mockRouterPush: vi.fn(),
}));

vi.mock("./actions", () => ({
  resetPasswordAction: mockResetPasswordAction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    render: renderProp,
    size: _size,
    className: _className,
    variant: _variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    render?: React.ReactElement;
    size?: string;
    className?: string;
    variant?: string;
  }) => {
    if (renderProp) {
      // render prop replaces the root element, children are slotted inside
      return React.cloneElement(renderProp, {}, children);
    }
    return (
      <button
        type={(type as "button" | "submit" | "reset") ?? "button"}
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </button>
    );
  },
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

import { ResetPasswordForm } from "./reset-password-form";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResetPasswordForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // (a) Render with valid token
  // ---------------------------------------------------------------------------

  it("renders new-password and confirm-password fields when token is provided", () => {
    render(<ResetPasswordForm token="valid-token-abc" />);

    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^confirm password$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /set new password/i }),
    ).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (b) Empty/missing token — immediate invalid-token UI
  // ---------------------------------------------------------------------------

  it("shows invalid-token UI when token is empty string", () => {
    render(<ResetPasswordForm token="" />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    // The form fields should NOT be present in the invalid-token state
    expect(
      screen.queryByRole("button", { name: /set new password/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a link back to /forgot-password in the invalid-token state", () => {
    render(<ResetPasswordForm token="" />);

    const link = screen.getByRole("link", { name: /request a new link/i });
    expect(link).toHaveAttribute("href", "/forgot-password");
  });

  // ---------------------------------------------------------------------------
  // (c) Success path
  // ---------------------------------------------------------------------------

  it("shows success message after action returns ok:true", async () => {
    const user = userEvent.setup({ delay: null });
    mockResetPasswordAction.mockResolvedValue({ ok: true });

    render(<ResetPasswordForm token="valid-token" />);

    await user.type(screen.getByLabelText(/^new password$/i), "newpassword1");
    await user.type(
      screen.getByLabelText(/^confirm password$/i),
      "newpassword1",
    );
    await user.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    expect(screen.getByRole("status")).toHaveTextContent(/password updated/i);
    expect(mockResetPasswordAction).toHaveBeenCalledOnce();
    expect(mockResetPasswordAction).toHaveBeenCalledWith({
      token: "valid-token",
      newPassword: "newpassword1",
      confirmPassword: "newpassword1",
    });
  });

  it("redirects to /login after the delay on success", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null });
    mockResetPasswordAction.mockResolvedValue({ ok: true });

    render(<ResetPasswordForm token="valid-token" />);

    await user.type(screen.getByLabelText(/^new password$/i), "newpassword1");
    await user.type(
      screen.getByLabelText(/^confirm password$/i),
      "newpassword1",
    );
    await user.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    vi.advanceTimersByTime(2000);
    vi.useRealTimers();

    expect(mockRouterPush).toHaveBeenCalledWith("/login");
  });

  // ---------------------------------------------------------------------------
  // (d) Invalid/expired token error
  // ---------------------------------------------------------------------------

  it("shows invalid-token UI when action returns an 'invalid or has expired' error", async () => {
    const user = userEvent.setup({ delay: null });
    mockResetPasswordAction.mockResolvedValue({
      ok: false,
      error: "This reset link is invalid or has expired.",
    });

    render(<ResetPasswordForm token="bad-token" />);

    await user.type(screen.getByLabelText(/^new password$/i), "newpassword1");
    await user.type(
      screen.getByLabelText(/^confirm password$/i),
      "newpassword1",
    );
    await user.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: /request a new link/i });
    expect(link).toHaveAttribute("href", "/forgot-password");
  });

  // ---------------------------------------------------------------------------
  // (e) Generic error
  // ---------------------------------------------------------------------------

  it("shows the error message in the form for non-token errors", async () => {
    const user = userEvent.setup({ delay: null });
    mockResetPasswordAction.mockResolvedValue({
      ok: false,
      error: "Failed to reset password. Please try again.",
    });

    render(<ResetPasswordForm token="valid-token" />);

    await user.type(screen.getByLabelText(/^new password$/i), "newpassword1");
    await user.type(
      screen.getByLabelText(/^confirm password$/i),
      "newpassword1",
    );
    await user.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to reset password. Please try again.",
    );
    // Password fields should still be visible
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (f) Submitting state
  // ---------------------------------------------------------------------------

  it("disables the submit button while submitting", async () => {
    const user = userEvent.setup({ delay: null });
    let resolve!: (val: { ok: boolean }) => void;
    mockResetPasswordAction.mockReturnValue(
      new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      }),
    );

    render(<ResetPasswordForm token="valid-token" />);

    await user.type(screen.getByLabelText(/^new password$/i), "newpassword1");
    await user.type(
      screen.getByLabelText(/^confirm password$/i),
      "newpassword1",
    );
    await user.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /updating/i })).toBeDisabled();
    });

    resolve({ ok: true });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });
});
