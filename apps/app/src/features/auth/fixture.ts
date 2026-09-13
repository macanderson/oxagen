// The sign-in flows' fixture data (MC_DATA=fixture, never production). It lets
// e2e and local development walk every screen without Postgres or Better Auth:
// the fixture operator from src/server/fixture-session.ts, one password, one
// authenticator code, one reset token and a small set of invitations that cover
// each invitation state. Values follow the mockup @ mc-baseline-w1 (W1).
//
// Promote: this belongs in lane L1's fixture seed (src/data/adapters/fixture)
// once an auth/org port exists; it lives here because L5 may not edit src/data.
import { FIXTURE_USER, isFixtureMode } from "@/server/fixture-session";
import type { InvitationView } from "./invitation";

export const FIXTURE_PASSWORD = "mission-control";
export const FIXTURE_TOTP_CODE = "602914";
export const FIXTURE_RESET_TOKEN = "rst_fixture_01";

/** The fixture organization and workspace every fixture flow lands in. */
export const FIXTURE_ORG = {
  slug: "acme",
  name: "Acme Robotics",
  namespace: "acme",
} as const;
export const FIXTURE_WORKSPACE = {
  slug: "core-platform",
  // Matches src/server/fixture-tenancy.ts (lane L4) so both seams name it alike.
  name: "Core platform",
  namespace: "core",
} as const;

export const FIXTURE_INVITATIONS: Readonly<Record<string, InvitationView>> = {
  invi_acme_pending: {
    token: "invi_acme_pending",
    orgName: FIXTURE_ORG.name,
    orgSlug: FIXTURE_ORG.slug,
    email: FIXTURE_USER.email,
    role: "member",
    status: "pending",
    inviterName: "Priya Raman",
    invitedAt: "2026-09-11T09:00:00.000Z",
    expiresAt: "2099-09-18T09:00:00.000Z",
  },
  invi_acme_accepted: {
    token: "invi_acme_accepted",
    orgName: FIXTURE_ORG.name,
    orgSlug: FIXTURE_ORG.slug,
    email: FIXTURE_USER.email,
    role: "member",
    status: "accepted",
    inviterName: "Priya Raman",
    invitedAt: "2026-09-09T09:00:00.000Z",
    expiresAt: "2026-09-16T09:00:00.000Z",
  },
  invi_acme_other: {
    token: "invi_acme_other",
    orgName: FIXTURE_ORG.name,
    orgSlug: FIXTURE_ORG.slug,
    email: "dana.okafor@acme.example",
    role: "compliance",
    status: "pending",
    inviterName: "Priya Raman",
    invitedAt: "2026-09-11T09:00:00.000Z",
    expiresAt: "2099-09-18T09:00:00.000Z",
  },
};

/** True when the fixture credentials match. Always false outside fixture mode. */
export function fixtureCredentialsMatch(
  email: string,
  password: string,
): boolean {
  if (!isFixtureMode()) return false;
  return (
    email.trim().toLowerCase() === FIXTURE_USER.email &&
    password === FIXTURE_PASSWORD
  );
}

/** The fixture invitation for a token, or null (unknown token, or not fixture mode). */
export function fixtureInvitation(token: string): InvitationView | null {
  if (!isFixtureMode()) return null;
  return Object.hasOwn(FIXTURE_INVITATIONS, token)
    ? (FIXTURE_INVITATIONS[token] ?? null)
    : null;
}
