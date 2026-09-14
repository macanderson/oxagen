// Read one invitation by its public token for /invite/[token], through the
// onboarding read port: the live adapter reads `org.invitations` by public id
// (src/data/adapters/live/onboarding.ts), the fixture adapter the seed's one
// invitation per state. The token's shape is checked here, before any read.
import "server-only";
import type { InvitationView } from "@/data/contracts/invitations";
import { type Read, readError } from "@/data/not-backed";
import { dataSource } from "@/data/source";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const INVITATION_NOT_FOUND = "invitation_not_found";

export function isInvitationToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export async function loadInvitation(
  token: string,
): Promise<Read<InvitationView>> {
  if (!isInvitationToken(token)) return readError(INVITATION_NOT_FOUND, 404);
  return (await dataSource()).onboarding.invitation(token);
}
