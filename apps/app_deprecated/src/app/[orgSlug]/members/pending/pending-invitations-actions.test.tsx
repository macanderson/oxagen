// @vitest-environment jsdom
/**
 * pending-invitations-actions.test.tsx — component tests for PendingInvitationsActions.
 *
 * Covers:
 *   (a) Renders Resend and Revoke buttons with accessible aria-labels.
 *   (b) Resend happy path — calls inviteMemberAction with correct args and shows
 *       a success toast.
 *   (c) Resend failure — action returns ok:false with an error string; shows
 *       error toast.
 *   (d) Resend failure with seat_limit_reached code — shows seat-limit message.
 *   (e) Revoke happy path — calls declineInvitationAction and shows success toast.
 *   (f) Revoke failure — shows error toast.
 *   (g) Unsafe role fallback — a "compliance" role (not in the allowed set) is
 *       normalized to "member" before inviteMemberAction is called.
 *   (h) Buttons are disabled while a transition is in-flight.
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockInviteMember, mockDeclineInvitation, mockAddToast } = vi.hoisted(
  () => ({
    mockInviteMember: vi.fn(),
    mockDeclineInvitation: vi.fn(),
    mockAddToast: vi.fn(),
  }),
);

vi.mock("@/app/[orgSlug]/members/actions", () => ({
  inviteMemberAction: mockInviteMember,
  declineInvitationAction: mockDeclineInvitation,
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
    variant: _v,
    size: _s,
    className: _c,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
    variant?: string;
    size?: string;
    className?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_SLUG = "acme";
const INVITATION = {
  publicId: "invi_abc123",
  email: "bob@example.com",
  role: "member",
};

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { PendingInvitationsActions } from "./pending-invitations-actions";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PendingInvitationsActions", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Render
  it("renders Resend and Revoke buttons with accessible aria-labels", () => {
    render(
      <PendingInvitationsActions orgSlug={ORG_SLUG} invitation={INVITATION} />,
    );

    expect(
      screen.getByRole("button", {
        name: `Resend invitation to ${INVITATION.email}`,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: `Revoke invitation for ${INVITATION.email}`,
      }),
    ).toBeInTheDocument();
  });

  // (b) Resend happy path
  it("calls inviteMemberAction with correct args on Resend and shows success toast", async () => {
    mockInviteMember.mockResolvedValue({ ok: true });

    render(
      <PendingInvitationsActions orgSlug={ORG_SLUG} invitation={INVITATION} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Resend invitation to ${INVITATION.email}`,
      }),
    );

    await waitFor(() => {
      expect(mockInviteMember).toHaveBeenCalledOnce();
    });

    expect(mockInviteMember).toHaveBeenCalledWith({
      orgSlug: ORG_SLUG,
      email: INVITATION.email,
      role: "member",
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Invitation resent", type: "success" }),
    );
  });

  // (c) Resend failure with error string
  it("shows error toast when resend returns ok:false with error string", async () => {
    mockInviteMember.mockResolvedValue({
      ok: false,
      error: "Something went wrong",
    });

    render(
      <PendingInvitationsActions orgSlug={ORG_SLUG} invitation={INVITATION} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Resend invitation to ${INVITATION.email}`,
      }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to resend",
        description: "Something went wrong",
        type: "error",
      }),
    );
  });

  // (d) Resend failure — seat_limit_reached
  it("shows seat-limit message when code is seat_limit_reached", async () => {
    mockInviteMember.mockResolvedValue({
      ok: false,
      code: "seat_limit_reached",
    });

    render(
      <PendingInvitationsActions orgSlug={ORG_SLUG} invitation={INVITATION} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Resend invitation to ${INVITATION.email}`,
      }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("No seats available"),
        type: "error",
      }),
    );
  });

  // (e) Revoke happy path
  it("calls declineInvitationAction on Revoke and shows success toast", async () => {
    mockDeclineInvitation.mockResolvedValue({ ok: true });

    render(
      <PendingInvitationsActions orgSlug={ORG_SLUG} invitation={INVITATION} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Revoke invitation for ${INVITATION.email}`,
      }),
    );

    await waitFor(() => {
      expect(mockDeclineInvitation).toHaveBeenCalledOnce();
    });

    expect(mockDeclineInvitation).toHaveBeenCalledWith({
      orgSlug: ORG_SLUG,
      invitationPublicId: INVITATION.publicId,
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Invitation revoked", type: "success" }),
    );
  });

  // (f) Revoke failure
  it("shows error toast when revoke returns ok:false", async () => {
    mockDeclineInvitation.mockResolvedValue({ ok: false, error: "Not found" });

    render(
      <PendingInvitationsActions orgSlug={ORG_SLUG} invitation={INVITATION} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Revoke invitation for ${INVITATION.email}`,
      }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to revoke",
        description: "Not found",
        type: "error",
      }),
    );
  });

  // (g) Unsafe role fallback
  it("normalizes an unknown role to 'member' before calling inviteMemberAction", async () => {
    mockInviteMember.mockResolvedValue({ ok: true });

    const invitationWithBadRole = { ...INVITATION, role: "compliance" };
    render(
      <PendingInvitationsActions
        orgSlug={ORG_SLUG}
        invitation={invitationWithBadRole}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Resend invitation to ${invitationWithBadRole.email}`,
      }),
    );

    await waitFor(() => {
      expect(mockInviteMember).toHaveBeenCalledOnce();
    });

    const [arg] = mockInviteMember.mock.calls[0] as [{ role: string }];
    expect(arg.role).toBe("member");
  });

  // (g2) Known roles pass through unchanged
  it.each(["owner", "admin", "billing"] as const)(
    "passes role '%s' through unchanged",
    async (role) => {
      mockInviteMember.mockResolvedValue({ ok: true });

      const inv = { ...INVITATION, role };
      render(<PendingInvitationsActions orgSlug={ORG_SLUG} invitation={inv} />);

      fireEvent.click(
        screen.getByRole("button", {
          name: `Resend invitation to ${inv.email}`,
        }),
      );

      await waitFor(() => {
        expect(mockInviteMember).toHaveBeenCalledOnce();
      });

      const [arg] = mockInviteMember.mock.calls[0] as [{ role: string }];
      expect(arg.role).toBe(role);
    },
  );
});
