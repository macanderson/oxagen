/**
 * Members page — static mock UI.
 *
 * Renders the MembersPanel with hardcoded realistic data.
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live member data in OXA-XXXX (see parent ticket).
 */

import type { OrgSeatUsage } from "@oxagen/billing";
import { MembersPanel } from "@/components/workspace/members-panel";

// ---------------------------------------------------------------------------
// Mock data — realistic, hardcoded. Replace with DB query when wired.
// ---------------------------------------------------------------------------

const MOCK_MEMBERS = [
  {
    publicId: "mem_01j9xwua",
    userId: "usr_01j9xwua",
    email: "mac@oxagen.ai",
    displayName: "Mac Anderson",
    role: "owner",
    joinedAt: "2026-05-28T00:00:00Z",
  },
  {
    publicId: "mem_02j9xwub",
    userId: "usr_02j9xwub",
    email: "sarah@acme.io",
    displayName: "Sarah Chen",
    role: "admin",
    joinedAt: "2026-05-29T00:00:00Z",
  },
  {
    publicId: "mem_03j9xwuc",
    userId: "usr_03j9xwuc",
    email: "james@acme.io",
    displayName: "James Park",
    role: "billing",
    joinedAt: "2026-05-30T00:00:00Z",
  },
  {
    publicId: "mem_04j9xwud",
    userId: "usr_04j9xwud",
    email: "priya@acme.io",
    displayName: "Priya Nair",
    role: "member",
    joinedAt: "2026-06-01T00:00:00Z",
  },
  {
    publicId: "mem_05j9xwue",
    userId: "usr_05j9xwue",
    email: "lena@acme.io",
    displayName: "Lena Brandt",
    role: "viewer",
    joinedAt: "2026-06-02T00:00:00Z",
  },
];

const MOCK_PENDING_INVITATIONS = [
  {
    publicId: "inv_01",
    email: "jordan.lee@acme.io",
    role: "admin",
    createdAt: "2026-06-05T10:00:00Z",
    expiresAt: "2026-06-13T10:00:00Z",
  },
  {
    publicId: "inv_02",
    email: "priya.sharma@acme.io",
    role: "member",
    createdAt: "2026-06-04T15:30:00Z",
    expiresAt: "2026-06-11T15:30:00Z",
  },
];

const MOCK_SEAT_USAGE: OrgSeatUsage = {
  licenses: 10,
  used: 5,
  available: 5,
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  return (
    <div className="flex flex-col gap-4">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>
      <MembersPanel
        orgSlug={orgSlug}
        members={MOCK_MEMBERS}
        pendingInvitations={MOCK_PENDING_INVITATIONS}
        seatUsage={MOCK_SEAT_USAGE}
        viewerRole="owner"
        viewerUserId="usr_01j9xwua"
      />
    </div>
  );
}
