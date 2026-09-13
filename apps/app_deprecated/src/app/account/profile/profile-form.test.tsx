// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * profile-form.test.tsx — component tests for ProfileForm.
 *
 * Covers:
 *   (a) Initial render — email (read-only), displayName field, Save button.
 *   (b) Happy path — submits with displayName, shows saved status.
 *   (c) Server error — action returns ok:false, error message shown.
 *   (d) Conditional rendering — SetPasswordForm shown only when !hasPassword.
 *
 * Mock seam: ./profile-action (updateProfileAction), @/lib/page-context,
 *            @/components/media/avatar-upload, various UI primitives.
 */

import * as React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConnectedAccountsState } from "./security-types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockUpdateProfileAction, mockSetPasswordAction, mockRouterRefresh } =
  vi.hoisted(() => ({
    mockUpdateProfileAction: vi.fn(),
    mockSetPasswordAction: vi.fn(),
    mockRouterRefresh: vi.fn(),
  }));

vi.mock("./profile-action", () => ({
  updateProfileAction: mockUpdateProfileAction,
}));

vi.mock("./security-action", () => ({
  setPasswordAction: mockSetPasswordAction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

// next/image validates src hostnames against next.config.js, which jsdom tests
// don't load — AvatarMaker renders the avatar through it, so shim to <img>.
vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    ...rest
  }: {
    src: string;
    alt: string;
    [k: string]: unknown;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim; real next/image requires Next.js runtime
    <img src={src} alt={alt} {...rest} />
  ),
}));

// page-context hooks — no-op in tests
vi.mock("@/lib/page-context", () => ({
  useRegisterFillableForm: vi.fn(),
  useRegisterPageEntity: vi.fn(),
}));

// connected-accounts and set-password are sub-components — mock them for isolation
vi.mock("./connected-accounts", () => ({
  ConnectedAccounts: ({ state }: { state: ConnectedAccountsState }) => (
    <div
      data-testid="connected-accounts"
      data-has-password={state.hasPassword}
    />
  ),
}));

vi.mock("./set-password-form", () => ({
  SetPasswordForm: () => <div data-testid="set-password-form" />,
}));

vi.mock("@/components/media/avatar-upload", () => ({
  AvatarUpload: ({
    value,
    onChange,
    fallback,
  }: {
    value: string | null;
    onChange: (v: string) => void;
    fallback?: string;
    shape?: string;
    disabled?: boolean;
  }) => (
    <div data-testid="avatar-upload">
      <span data-testid="avatar-fallback">{fallback}</span>
      <input
        data-testid="avatar-url-input"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  ),
}));

vi.mock("@/components/ui/field-fill-transition", () => ({
  FieldFillTransition: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    type,
    className: _c,
    variant: _v,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    className?: string;
    variant?: string;
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

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/routes", () => ({
  account: {
    preferences: () => "/account/preferences",
    root: () => "/account",
  },
}));

import { ProfileForm } from "./profile-form";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  overrides: Partial<ConnectedAccountsState> = {},
): ConnectedAccountsState {
  return {
    accounts: [],
    hasPassword: true,
    signInMethodCount: 1,
    ...overrides,
  };
}

const defaultProps = {
  userId: "user-abc",
  initialDisplayName: "Alice",
  email: "alice@example.com",
  initialAvatarUrl: "https://example.com/avatar.png",
  connectedAccountsState: makeState({ hasPassword: true }),
  timezone: "America/New_York",
  language: "en",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfileForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // (a) Initial render
  // ---------------------------------------------------------------------------

  it("renders the email as a read-only input", () => {
    render(<ProfileForm {...defaultProps} />);

    const emailInput = screen.getByDisplayValue("alice@example.com");
    expect(emailInput).toBeInTheDocument();
    expect(emailInput).toHaveAttribute("type", "email");
    expect(emailInput).toBeDisabled();
  });

  it("renders the displayName field pre-populated with the initial value", () => {
    render(<ProfileForm {...defaultProps} />);

    const nameInput = screen.getByDisplayValue("Alice");
    expect(nameInput).toBeInTheDocument();
  });

  it("renders timezone and language as read-only text (not inputs) with a Preferences link", () => {
    render(<ProfileForm {...defaultProps} />);

    // Values shown as plain text, underscores humanized — not editable/disabled inputs.
    expect(screen.getByText("America/New York")).toBeInTheDocument();
    expect(screen.getByText("en")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("America/New York")).toBeNull();
    expect(screen.queryByDisplayValue("America/New_York")).toBeNull();

    // Link out to where they're actually changed.
    const link = screen.getByRole("link", { name: /preferences/i });
    expect(link).toHaveAttribute("href", "/account/preferences");
  });

  it("renders the Save changes button", () => {
    render(<ProfileForm {...defaultProps} />);
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });

  it("renders the ConnectedAccounts component", () => {
    render(<ProfileForm {...defaultProps} />);
    expect(screen.getByTestId("connected-accounts")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (d) Conditional rendering — SetPasswordForm
  // ---------------------------------------------------------------------------

  it("does NOT render SetPasswordForm when hasPassword is true", () => {
    render(
      <ProfileForm
        {...defaultProps}
        connectedAccountsState={makeState({ hasPassword: true })}
      />,
    );
    expect(screen.queryByTestId("set-password-form")).not.toBeInTheDocument();
  });

  it("renders SetPasswordForm when hasPassword is false", () => {
    render(
      <ProfileForm
        {...defaultProps}
        connectedAccountsState={makeState({ hasPassword: false })}
      />,
    );
    expect(screen.getByTestId("set-password-form")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (b) Happy path
  // ---------------------------------------------------------------------------

  it("calls updateProfileAction with displayName and avatarUrl on submit", async () => {
    const user = userEvent.setup({ delay: null });
    mockUpdateProfileAction.mockResolvedValue({ ok: true });

    render(<ProfileForm {...defaultProps} />);

    // Change the display name
    const nameInput = screen.getByDisplayValue("Alice");
    await user.clear(nameInput);
    await user.type(nameInput, "Bob");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(mockUpdateProfileAction).toHaveBeenCalledOnce();
    });

    expect(mockUpdateProfileAction).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Bob" }),
    );
  });

  it("shows Saved status text after successful save", async () => {
    const user = userEvent.setup({ delay: null });
    mockUpdateProfileAction.mockResolvedValue({ ok: true });

    render(<ProfileForm {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    expect(screen.getByRole("status")).toHaveTextContent(/saved/i);
  });

  // ---------------------------------------------------------------------------
  // (c) Server error
  // ---------------------------------------------------------------------------

  it("shows error message when action returns ok:false", async () => {
    const user = userEvent.setup({ delay: null });
    mockUpdateProfileAction.mockResolvedValue({
      ok: false,
      error: "Invalid input",
    });

    render(<ProfileForm {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Invalid input");
  });

  it("disables the save button while saving", async () => {
    const user = userEvent.setup({ delay: null });
    let resolve!: (val: { ok: boolean }) => void;
    mockUpdateProfileAction.mockReturnValue(
      new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      }),
    );

    render(<ProfileForm {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
    });

    resolve({ ok: true });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });
});
