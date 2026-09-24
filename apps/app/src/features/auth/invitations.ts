// Read one invitation by its public token for /invite/[token], through the
// viewer seam's anonymous read (src/server/viewer.ts `readInvitation`, #3049):
// the visitor holds no membership in the invitation's org yet, so the token is
// the capability and the page shows only what the invitation email already
// disclosed. The token's shape is checked there, before any read. The mapping to
// the view model stays here: src/server may not import @/data/contracts (§2).
import "server-only";
import { InvitationView, toOrgRole } from "@/data/contracts/invitations";
import { type Read, readError, readOk } from "@/data/read";
import { type InvitationRecord, readInvitation } from "@/server/viewer";

const INVITATION_NOT_FOUND = "invitation_not_found";

/** The stored row as the page's view model; a row outside the enums is unreadable, never guessed at. */
function toInvitationView(
  token: string,
  record: InvitationRecord,
): Read<InvitationView> {
  const parsed = InvitationView.safeParse({
    token,
    orgName: record.orgName,
    orgSlug: record.orgSlug,
    email: record.email,
    role: toOrgRole(record.role),
    status: record.status,
    invitedAt: record.invitedAt.toISOString(),
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    inviterName: record.inviterName,
    inviterRole:
      record.inviterRole === null ? null : toOrgRole(record.inviterRole),
  });
  return parsed.success
    ? readOk(parsed.data)
    : readError("invitation_unreadable", 500);
}

export async function loadInvitation(
  token: string,
): Promise<Read<InvitationView>> {
  const record = await readInvitation(token);
  if (!record) return readError(INVITATION_NOT_FOUND, 404);
  return toInvitationView(token, record);
}
