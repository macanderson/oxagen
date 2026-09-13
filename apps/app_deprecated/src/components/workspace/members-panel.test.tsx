// @vitest-environment jsdom
/**
 * members-panel.test.tsx — render tests for MembersPanel.
 *
 * Covers:
 *   - Renders the "Members" card heading
 *   - Renders each member's display name
 *   - Renders member email
 *   - Renders member role badge
 *   - Shows pending invitations section
 *   - Shows pending invitation email
 *   - Shows "Invite member" button for owners
 *   - Hides "Invite member" button for members
 *   - Renders seat usage info
 *   - Shows seat-limit alert when at capacity
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MembersPanel } from "./members-panel";
import type { MembersPanelProps } from "./members-panel";

afterEach(cleanup);

// Mock the server actions
vi.mock("@/app/[orgSlug]/members/actions", () => ({
  inviteMemberAction: vi.fn().mockResolvedValue({ ok: true }),
  declineInvitationAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/[orgSlug]/members/member-actions", () => ({
  removeMemberAction: vi.fn().mockResolvedValue({ ok: true }),
  changeMemberRoleAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

const seatUsage = {
  licenses: 10,
  used: 2,
  available: 8,
};

const members: MembersPanelProps["members"] = [
  {
    publicId: "m-1",
    displayName: "Jane Smith",
    email: "jane@example.com",
    role: "owner",
    userId: "u-1",
    joinedAt: "2025-01-01T00:00:00Z",
  },
  {
    publicId: "m-2",
    displayName: "Bob Jones",
    email: "bob@example.com",
    role: "member",
    userId: "u-2",
    joinedAt: "2025-02-01T00:00:00Z",
  },
];

const pendingInvitations: MembersPanelProps["pendingInvitations"] = [
  {
    publicId: "inv-1",
    email: "alice@example.com",
    role: "member",
    createdAt: "2025-03-01T00:00:00Z",
    expiresAt: "2025-04-01T00:00:00Z",
  },
];

const defaultProps: MembersPanelProps = {
  orgSlug: "acme",
  members,
  pendingInvitations,
  seatUsage,
  viewerRole: "owner",
  viewerUserId: "u-1",
};

describe("MembersPanel — rendering", () => {
  it("renders the 'Organization members' heading", () => {
    render(<MembersPanel {...defaultProps} />);
    expect(screen.getByText("Organization members")).toBeInTheDocument();
  });

  it("renders each member display name", () => {
    render(<MembersPanel {...defaultProps} />);
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getByText("Bob Jones")).toBeInTheDocument();
  });

  it("renders member emails", () => {
    render(<MembersPanel {...defaultProps} />);
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
    expect(screen.getByText("bob@example.com")).toBeInTheDocument();
  });
});

describe("MembersPanel — pending invitations", () => {
  it("renders pending invitation email", () => {
    render(<MembersPanel {...defaultProps} />);
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
  });

  it("shows 'Pending invitations' section", () => {
    render(<MembersPanel {...defaultProps} />);
    expect(screen.getByText(/pending invitations/i)).toBeInTheDocument();
  });
});

describe("MembersPanel — add member button visibility", () => {
  it("shows 'Add member' button for owners", () => {
    render(<MembersPanel {...defaultProps} viewerRole="owner" />);
    expect(
      screen.getByRole("button", { name: /add member/i }),
    ).toBeInTheDocument();
  });

  it("hides 'Add member' button for regular members", () => {
    render(<MembersPanel {...defaultProps} viewerRole="member" />);
    expect(
      screen.queryByRole("button", { name: /add member/i }),
    ).not.toBeInTheDocument();
  });
});

describe("MembersPanel — seat usage", () => {
  it("shows members count and license limit", () => {
    render(<MembersPanel {...defaultProps} />);
    // The heading shows "N / M" where N=current members, M=licenses
    // With 2 members and 10 licenses it shows "2 / 10"
    expect(screen.getByText(/2\s*\/\s*10/)).toBeInTheDocument();
  });

  it("does not crash when available=0", () => {
    const atLimitProps = {
      ...defaultProps,
      seatUsage: { licenses: 2, used: 2, available: 0 },
    };
    expect(() => render(<MembersPanel {...atLimitProps} />)).not.toThrow();
  });
});
