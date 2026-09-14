// @vitest-environment jsdom
/**
 * invite-member-inline.test.tsx
 *
 * Render + interaction tests for InviteMemberInline:
 *   - Renders email input with label
 *   - Pre-fills email from suggestedEmail
 *   - Shows error when inviteMemberAction fails
 *   - Shows success state with email + role when action succeeds
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("@/app/[orgSlug]/members/actions", () => ({
  inviteMemberAction: vi.fn(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    "aria-busy": ariaBusy,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: string;
    "aria-busy"?: boolean;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-busy={ariaBusy}
    >
      {children}
    </button>
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

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({
    children,
    id,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-label"?: string;
  }) => (
    <button id={id} aria-label={ariaLabel} type="button">
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    UserPlus: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("InviteMemberInline", () => {
  it("renders form with aria-label", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({ ok: true });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(<InviteMemberInline />);
    expect(
      screen.getByRole("form", { name: "Invite member" }),
    ).toBeInTheDocument();
  });

  it("renders email input", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({ ok: true });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(<InviteMemberInline />);
    expect(
      screen.getByPlaceholderText("teammate@company.com"),
    ).toBeInTheDocument();
  });

  it("pre-fills email from suggestedEmail prop", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({ ok: true });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(<InviteMemberInline suggestedEmail="alice@example.com" />);
    const input = screen.getByPlaceholderText(
      "teammate@company.com",
    ) as HTMLInputElement;
    expect(input.value).toBe("alice@example.com");
  });

  it("submit button is disabled when email is empty", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({ ok: true });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(<InviteMemberInline />);
    const submitBtn = screen.getByRole("button", { name: "Send invitation" });
    expect(submitBtn).toBeDisabled();
  });

  it("submit button is enabled when email is filled", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({ ok: true });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(<InviteMemberInline suggestedEmail="alice@example.com" />);
    const submitBtn = screen.getByRole("button", { name: "Send invitation" });
    expect(submitBtn).not.toBeDisabled();
  });

  it("shows error when inviteMemberAction fails", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({
      ok: false,
      code: "internal",
      error: "User already invited",
    });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(
      <InviteMemberInline
        suggestedEmail="alice@example.com"
        orgSlug="my-org"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send invitation" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "User already invited",
      );
    });
  });

  it("shows success state when action succeeds", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({ ok: true });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(
      <InviteMemberInline
        suggestedEmail="alice@example.com"
        orgSlug="my-org"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send invitation" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Invitation sent")).toBeInTheDocument();
    });
  });

  it("shows email in success state summary", async () => {
    const { inviteMemberAction } = await import(
      "@/app/[orgSlug]/members/actions"
    );
    vi.mocked(inviteMemberAction).mockResolvedValue({ ok: true });

    const { default: InviteMemberInline } = await import(
      "./invite-member-inline"
    );
    render(
      <InviteMemberInline
        suggestedEmail="alice@example.com"
        orgSlug="my-org"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Send invitation" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
    });
  });
});
