/**
 * Pending invitations page — live data.
 *
 * Shows all pending invitations for the org. Resend and Revoke actions are
 * wired: Revoke calls declineInvitationAction (which sets status='declined').
 * Resend is a client action that calls inviteMemberAction with the same
 * email+role, which re-creates the invitation row (previous declined or
 * expired rows don't block it).
 */

import { Mail } from "lucide-react";
import { and, eq } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, assertOrgMember, getOrgRole } from "@/lib/resolve-org";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PendingInvitationsActions } from "./pending-invitations-actions";

// Sentinel workspaceId for org-only routes.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

function formatExpiry(d: Date | null): string {
  if (!d) return "";
  const diff = d.getTime() - Date.now();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

export default async function MembersPendingPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [org, session] = await Promise.all([
    resolveOrg(orgSlug),
    getSessionOrRedirect(),
  ]);
  const viewerUserId = session.user.id;

  // IDOR guard, unconditional: a missing session redirects to /login above, so
  // invitee email addresses and invitation ids never render ungated.
  await assertOrgMember(org.id, viewerUserId);

  const [invitations, viewerRole] = await Promise.all([
    runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb((tx) =>
        tx
          .select({
            publicId: schema.invitations.publicId,
            email: schema.invitations.email,
            role: schema.invitations.role,
            expiresAt: schema.invitations.expiresAt,
          })
          .from(schema.invitations)
          .where(
            and(
              eq(schema.invitations.orgId, org.id),
              eq(schema.invitations.status, "pending"),
            ),
          ),
      ),
    ),
    getOrgRole(org.id, viewerUserId),
  ]);

  const canManage = ["owner", "admin"].includes(viewerRole ?? "");

  if (invitations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-border/60 bg-muted/30 px-6 py-16 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Mail className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">
            No pending invitations
          </p>
          <p className="text-xs text-muted-foreground">
            Members who have been invited but have not yet accepted will appear
            here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Pending invitations
          <Badge variant="secondary">{invitations.length}</Badge>
        </span>
      }
    >
      <ul className="divide-y divide-border/60">
        {invitations.map((inv) => (
          <li
            key={inv.publicId}
            className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
          >
            {/* Avatar initial */}
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-xs font-medium text-muted-foreground uppercase">
              {inv.email.charAt(0)}
            </span>

            {/* Email + expiry */}
            <div className="flex flex-1 flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground truncate">
                {inv.email}
              </span>
              {inv.expiresAt ? (
                <span className="text-xs text-muted-foreground">
                  {formatExpiry(inv.expiresAt)}
                </span>
              ) : null}
            </div>

            {/* Role + actions */}
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="outline" className="capitalize text-xs">
                {inv.role}
              </Badge>
              {canManage ? (
                <PendingInvitationsActions
                  orgSlug={orgSlug}
                  invitation={{
                    publicId: inv.publicId,
                    email: inv.email,
                    role: inv.role,
                  }}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
