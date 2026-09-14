/**
 * Access → Reviews: quarterly access review snapshot.
 *
 * Shows all org members + role + last-active (max security_events.occurred_at
 * by actor) with Confirm / Revoke actions per member (CC6.3 evidence).
 *
 * Every Confirm emits access.member_access_confirmed.
 * Every Revoke emits org.member_removed + access.review_completed.
 */

import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import {
  resolveOrg,
  assertOrgMember,
  getOrgRole,
  SECURITY_MANAGER_ROLES,
} from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { ReviewRowActions } from "./_components/review-row-actions";

interface MemberReviewRow {
  userId: string;
  userName: string | null;
  userEmail: string;
  role: string;
  joinedAt: Date;
  lastActiveAt: Date | null;
}

async function loadMemberReviews(orgId: string): Promise<MemberReviewRow[]> {
  // Join org_users + users; left-join security_events for last-active.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        userId: schema.orgUsers.userId,
        userName: schema.users.displayName,
        userEmail: schema.users.email,
        role: schema.orgUsers.role,
        joinedAt: schema.orgUsers.joinedAt,
        lastActiveAt: max(schema.securityEvents.occurredAt),
      })
      .from(schema.orgUsers)
      .innerJoin(schema.users, eq(schema.users.id, schema.orgUsers.userId))
      .leftJoin(
        schema.securityEvents,
        and(
          eq(schema.securityEvents.actorUserId, schema.orgUsers.userId),
          eq(schema.securityEvents.orgId, orgId),
        ),
      )
      .where(eq(schema.orgUsers.orgId, orgId))
      .groupBy(
        schema.orgUsers.userId,
        schema.users.displayName,
        schema.users.email,
        schema.orgUsers.role,
        schema.orgUsers.joinedAt,
      )
      .orderBy(desc(sql`max(${schema.securityEvents.occurredAt})`)),
  );

  return rows.map((r) => ({
    userId: r.userId,
    userName: r.userName,
    userEmail: r.userEmail,
    role: r.role,
    joinedAt: r.joinedAt,
    lastActiveAt: r.lastActiveAt ?? null,
  }));
}

const ROLE_VARIANT: Record<string, "default" | "muted" | "outline"> = {
  owner: "default",
  admin: "default",
  billing: "muted",
  member: "outline",
};

export default async function AccessReviewsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [session, tenant] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(tenant.id, session.user.id);

  const [members, role] = await Promise.all([
    loadMemberReviews(tenant.id),
    getOrgRole(tenant.id, session.user.id),
  ]);

  const canRevoke = role != null && SECURITY_MANAGER_ROLES.has(role);

  return (
    <div className="flex flex-col gap-6">
      <Panel
        title={
          <>
            Access review{" "}
            <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
              {members.length}
            </span>
          </>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Quarterly review of all org members, roles, and last-active
          timestamps. Confirm or revoke each member&apos;s access to satisfy SOC
          2 CC6.3 access provisioning evidence.
        </p>

        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members found.</p>
        ) : (
          <>
            {/* Column headers */}
            <div
              className="mb-2 hidden px-4 sm:grid sm:gap-4"
              style={{
                gridTemplateColumns: "minmax(0,1.8fr) 80px 140px 140px 180px",
              }}
            >
              {["Member", "Role", "Joined", "Last active", ""].map((h) => (
                <span
                  key={h}
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </span>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              {members.map((m) => (
                <div
                  key={m.userId}
                  className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-sm grid grid-cols-1 gap-y-1.5 sm:gap-4 sm:items-center"
                  style={{
                    gridTemplateColumns:
                      "minmax(0,1.8fr) 80px 140px 140px 180px",
                  }}
                >
                  {/* Member */}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium text-foreground truncate">
                      {m.userName ?? m.userEmail}
                    </span>
                    {m.userName && (
                      <span className="text-xs text-muted-foreground truncate">
                        {m.userEmail}
                      </span>
                    )}
                  </div>

                  {/* Role */}
                  <Badge
                    variant={ROLE_VARIANT[m.role] ?? "outline"}
                    className="w-fit text-xs capitalize"
                  >
                    {m.role}
                  </Badge>

                  {/* Joined */}
                  <span className="text-xs text-muted-foreground">
                    {formatDate(m.joinedAt)}
                  </span>

                  {/* Last active */}
                  <span className="text-xs text-muted-foreground">
                    {formatDate(m.lastActiveAt)}
                  </span>

                  {/* Actions */}
                  <ReviewRowActions
                    orgSlug={orgSlug}
                    targetUserId={m.userId}
                    targetUserName={m.userName ?? m.userEmail}
                    canRevoke={canRevoke}
                    isSelf={m.userId === session.user.id}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
