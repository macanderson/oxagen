// Read one invitation by its public token for /invite/[token], through the
// system lookups seam (src/server/tenancy-lookups.ts): the visitor holds no
// membership in the invitation's org yet, so the token is the capability and
// the page shows only what the invitation email already disclosed. The token's
// shape is checked here, before any read.
import "server-only";
import { InvitationView, toOrgRole } from "@/data/contracts/invitations";
import { type Read, readError, readOk } from "@/data/read";
import { type InvitationRecord, systemLookups } from "@/server/tenancy-lookups";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const INVITATION_NOT_FOUND = "invitation_not_found";

function isInvitationToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

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
  });
  return parsed.success
    ? readOk(parsed.data)
    : readError("invitation_unreadable", 500);
}

export async function loadInvitation(
  token: string,
): Promise<Read<InvitationView>> {
  if (!isInvitationToken(token)) return readError(INVITATION_NOT_FOUND, 404);
  const record = await systemLookups.invitationByToken(token);
  if (!record) return readError(INVITATION_NOT_FOUND, 404);
  return toInvitationView(token, record);
}
