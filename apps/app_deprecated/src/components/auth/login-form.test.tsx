// @vitest-environment jsdom
/**
 * login-form.test.tsx — render + interaction tests for LoginForm.
 *
 * Covers signin and signup modes:
 *   - signin: renders Email/Password/Sign-in button, shows "Forgot password?" link
 *   - signup: renders Name/Email/Password/Create-account button
 *   - Submit calls authClient.signIn.email or signUp.email with correct args
 *   - Error message renders on auth failure
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm } from "./login-form";

afterEach(cleanup);

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Use vi.hoisted so the mocks are available before vi.mock hoisting
const { signInEmailMock, signUpEmailMock, pushMock } = vi.hoisted(() => ({
  signInEmailMock: vi.fn(),
  signUpEmailMock: vi.fn(),
  pushMock: vi.fn(),
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

vi.mock("@oxagen/auth/client", () => ({
  authClient: {
    signIn: { email: signInEmailMock },
    signUp: { email: signUpEmailMock },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  signInEmailMock.mockResolvedValue({ error: null });
  signUpEmailMock.mockResolvedValue({ error: null });
});

describe("LoginForm — signin mode (default)", () => {
  it("renders email and password inputs", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("renders 'Sign in' submit button", () => {
    render(<LoginForm />);
    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
  });

  it("shows 'Forgot password?' link", () => {
    render(<LoginForm />);
    expect(
      screen.getByRole("link", { name: /forgot password/i }),
    ).toBeInTheDocument();
  });

  it("does NOT render the Name field in signin mode", () => {
    render(<LoginForm />);
    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
  });

  it("calls authClient.signIn.email with email and password", async () => {
    render(<LoginForm mode="signin" />);
    await userEvent.type(screen.getByLabelText(/email/i), "user@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "password123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(signInEmailMock).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "password123",
      });
    });
  });

  it("routes to /two-factor when sign-in requires a second factor", async () => {
    signInEmailMock.mockResolvedValueOnce({
      data: { twoFactorRedirect: true },
      error: null,
    });
    render(<LoginForm mode="signin" />);
    await userEvent.type(screen.getByLabelText(/email/i), "user@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "password123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/two-factor"));
    // Must NOT fall through to the app root before the second factor is verified.
    expect(pushMock).not.toHaveBeenCalledWith("/");
  });

  it("routes to the app root on a normal sign-in (no second factor)", async () => {
    signInEmailMock.mockResolvedValueOnce({ data: {}, error: null });
    render(<LoginForm mode="signin" />);
    await userEvent.type(screen.getByLabelText(/email/i), "user@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "password123");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/"));
    expect(pushMock).not.toHaveBeenCalledWith("/two-factor");
  });

  it("shows error message on auth failure", async () => {
    signInEmailMock.mockResolvedValueOnce({
      error: { message: "Invalid credentials" },
    });
    render(<LoginForm />);
    await userEvent.type(screen.getByLabelText(/email/i), "user@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument(),
    );
  });
});

describe("LoginForm — signup mode", () => {
  it("renders name, email, password inputs", () => {
    render(<LoginForm mode="signup" />);
    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("renders 'Create account' submit button", () => {
    render(<LoginForm mode="signup" />);
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
  });

  it("does NOT show 'Forgot password?' link in signup mode", () => {
    render(<LoginForm mode="signup" />);
    expect(screen.queryByText(/forgot password/i)).not.toBeInTheDocument();
  });

  it("calls authClient.signUp.email with name, email, password", async () => {
    render(<LoginForm mode="signup" />);
    await userEvent.type(screen.getByLabelText(/^name$/i), "Jane Smith");
    await userEvent.type(screen.getByLabelText(/email/i), "jane@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "securepass");
    await userEvent.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    await waitFor(() => {
      expect(signUpEmailMock).toHaveBeenCalledWith({
        name: "Jane Smith",
        email: "jane@example.com",
        password: "securepass",
      });
    });
  });
});
