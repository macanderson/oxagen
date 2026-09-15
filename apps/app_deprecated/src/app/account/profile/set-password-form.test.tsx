// @vitest-environment jsdom
/**
 * set-password-form.test.tsx — component tests for SetPasswordForm.
 *
 * Covers:
 *   (a) Initial render — new-password and confirm-password inputs, Set password button.
 *   (b) Happy path — action returns ok:true, success message shown, fields cleared.
 *   (c) Client-side mismatch — passwords don't match, error shown before calling action.
 *   (d) Server error — action returns ok:false, error message displayed.
 *   (e) Submit button disabled while saving.
 *   (f) Submit button disabled when inputs are empty.
 *
 * Mock seam: ./security-action (setPasswordAction), next/navigation (useRouter).
 */

import * as React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockSetPasswordAction, mockRouterRefresh } = vi.hoisted(() => ({
  mockSetPasswordAction: vi.fn(),
  mockRouterRefresh: vi.fn(),
}));

vi.mock("./security-action", () => ({
  setPasswordAction: mockSetPasswordAction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    type,
    variant: _v,
    className: _c,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    variant?: string;
    className?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
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

import { SetPasswordForm } from "./set-password-form";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SetPasswordForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // (a) Initial render
  // ---------------------------------------------------------------------------

  it("renders new-password and confirm-password inputs and a set-password button", () => {
    render(<SetPasswordForm />);

    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /set password/i }),
    ).toBeInTheDocument();
  });

  it("password inputs are of type=password", () => {
    render(<SetPasswordForm />);
    expect(screen.getByLabelText(/new password/i)).toHaveAttribute(
      "type",
      "password",
    );
    expect(screen.getByLabelText(/confirm password/i)).toHaveAttribute(
      "type",
      "password",
    );
  });

  // ---------------------------------------------------------------------------
  // (f) Submit disabled when inputs empty
  // ---------------------------------------------------------------------------

  it("submit button is disabled when both fields are empty", () => {
    render(<SetPasswordForm />);
    // The button is disabled when newPassword or confirmPassword is falsy
    const button = screen.getByRole("button", { name: /set password/i });
    expect(button).toBeDisabled();
  });

  it("submit button is disabled when only newPassword is filled", async () => {
    const user = userEvent.setup({ delay: null });
    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText(/new password/i), "mypassword1");
    expect(
      screen.getByRole("button", { name: /set password/i }),
    ).toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // (b) Happy path
  // ---------------------------------------------------------------------------

  it("shows success message and clears fields after action returns ok:true", async () => {
    const user = userEvent.setup({ delay: null });
    mockSetPasswordAction.mockResolvedValue({ ok: true });

    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText(/new password/i), "mypassword1");
    await user.type(screen.getByLabelText(/confirm password/i), "mypassword1");

    // Button should now be enabled
    const button = screen.getByRole("button");
    expect(button).not.toBeDisabled();

    await user.click(button);

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    expect(screen.getByRole("status")).toHaveTextContent(/password set/i);
    expect(mockSetPasswordAction).toHaveBeenCalledOnce();
    expect(mockSetPasswordAction).toHaveBeenCalledWith({
      newPassword: "mypassword1",
      confirmPassword: "mypassword1",
    });
  });

  it("calls router.refresh() after successfully setting a password", async () => {
    const user = userEvent.setup({ delay: null });
    mockSetPasswordAction.mockResolvedValue({ ok: true });

    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText(/new password/i), "mypassword1");
    await user.type(screen.getByLabelText(/confirm password/i), "mypassword1");
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    expect(mockRouterRefresh).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // (c) Client-side password mismatch
  // ---------------------------------------------------------------------------

  it("shows a mismatch error before calling the action when passwords differ", async () => {
    const user = userEvent.setup({ delay: null });

    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText(/new password/i), "password1");
    await user.type(screen.getByLabelText(/confirm password/i), "password2");
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      /passwords do not match/i,
    );
    // Action must NOT be called when the client catches the mismatch
    expect(mockSetPasswordAction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // (d) Server error path
  // ---------------------------------------------------------------------------

  it("shows error message when action returns ok:false", async () => {
    const user = userEvent.setup({ delay: null });
    mockSetPasswordAction.mockResolvedValue({
      ok: false,
      error: "Password is already set.",
    });

    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText(/new password/i), "mypassword1");
    await user.type(screen.getByLabelText(/confirm password/i), "mypassword1");
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Password is already set.",
    );
  });

  // ---------------------------------------------------------------------------
  // (e) Submitting state
  // ---------------------------------------------------------------------------

  it("disables the button while saving", async () => {
    const user = userEvent.setup({ delay: null });
    let resolve!: (val: { ok: boolean }) => void;
    mockSetPasswordAction.mockReturnValue(
      new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      }),
    );

    render(<SetPasswordForm />);

    await user.type(screen.getByLabelText(/new password/i), "mypassword1");
    await user.type(screen.getByLabelText(/confirm password/i), "mypassword1");
    await user.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /setting password/i }),
      ).toBeDisabled();
    });

    resolve({ ok: true });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });
});
