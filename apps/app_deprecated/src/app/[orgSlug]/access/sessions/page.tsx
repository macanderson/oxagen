/**
 * Access → Sessions: live org session manager with revoke.
 *
 * Loads all active sessions for org members by joining:
 *   auth.sessions → auth.users → org.org_users (to scope to this org).
 *
 * Owner/admin can revoke any session. Revoke emits security.session_revoked.
 * CC6.1 evidence.
 */

import { Globe, Laptop, Smartphone, Bot, CircleSlash } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { eq, and, gt, inArray } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import {
  resolveOrg,
  assertOrgMember,
  getOrgRole,
  SECURITY_MANAGER_ROLES,
} from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { RevokeSessionButton } from "./_components/revoke-session-button";

type DeviceKind = "desktop" | "mobile" | "headless";

interface LiveSession {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  deviceKind: DeviceKind;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

function classifyDevice(ua: string | null): DeviceKind {
  if (!ua) return "headless";
  const u = ua.toLowerCase();
  if (u.includes("mobile") || u.includes("android") || u.includes("iphone"))
    return "mobile";
  if (
    u.includes("mozilla") ||
    u.includes("chrome") ||
    u.includes("safari") ||
    u.includes("firefox")
  )
    return "desktop";
  return "headless";
}

async function loadOrgSessions(orgId: string): Promise<LiveSession[]> {
  const now = new Date();
  // Fetch all active (non-expired) sessions for members of this org.
  // Step 1: get all user IDs in the org.
  const memberRows = await withSystemDb((tx) =>
    tx
      .select({ userId: schema.orgUsers.userId })
      .from(schema.orgUsers)
      .where(eq(schema.orgUsers.orgId, orgId)),
  );

  if (memberRows.length === 0) return [];

  const userIds = memberRows.map((r) => r.userId);

  // Step 2: load active sessions + user info for those members.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        sessionId: schema.sessions.id,
        userId: schema.sessions.userId,
        userAgent: schema.sessions.userAgent,
        ip: schema.sessions.ipAddress,
        createdAt: schema.sessions.createdAt,
        updatedAt: schema.sessions.updatedAt,
        expiresAt: schema.sessions.expiresAt,
        userName: schema.users.displayName,
        userEmail: schema.users.email,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          inArray(schema.sessions.userId, userIds),
          gt(schema.sessions.expiresAt, now),
        ),
      )
      .orderBy(schema.sessions.updatedAt),
  );

  return rows.map((r) => ({
    id: r.sessionId,
    userId: r.userId,
    userName: r.userName,
    userEmail: r.userEmail,
    deviceKind: classifyDevice(r.userAgent),
    userAgent: r.userAgent,
    ip: r.ip,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
  }));
}

function DeviceIcon({ kind }: { kind: DeviceKind }) {
  if (kind === "mobile")
    return (
      <Smartphone
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-label="Mobile"
      />
    );
  if (kind === "headless")
    return (
      <Bot
        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        aria-label="API / headless"
      />
    );
  return (
    <Laptop
      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      aria-label="Desktop"
    />
  );
}

function formatTs(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extractBrowser(ua: string | null): string {
  if (!ua) return "Unknown";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg")) return "Edge";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  return ua.slice(0, 40);
}

export default async function AccessSessionsPage({
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

  const [sessions, role] = await Promise.all([
    loadOrgSessions(tenant.id),
    getOrgRole(tenant.id, session.user.id),
  ]);

  const canRevoke = role != null && SECURITY_MANAGER_ROLES.has(role);

  return (
    <div className="flex flex-col gap-6">
      <Panel
        title={
          <>
            Active sessions{" "}
            <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
              {sessions.length}
            </span>
          </>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          All unexpired sessions for members of this organization. Owner and
          admin roles can revoke any session (CC6.1).
        </p>

        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active sessions found.
          </p>
        ) : (
          <>
            {/* Column headers (desktop) */}
            <div
              className="mb-2 hidden px-4 sm:grid sm:gap-4"
              style={{
                gridTemplateColumns: canRevoke
                  ? "minmax(0,1.6fr) 110px 110px 160px 120px"
                  : "minmax(0,1.6fr) 110px 110px 160px",
              }}
            >
              {[
                "User",
                "Device",
                "IP",
                "Last active",
                ...(canRevoke ? [""] : []),
              ].map((h) => (
                <span
                  key={h}
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </span>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-sm grid grid-cols-1 gap-y-1 sm:gap-4 sm:items-center"
                  style={{
                    gridTemplateColumns: canRevoke
                      ? "minmax(0,1.6fr) 110px 110px 160px 120px"
                      : "minmax(0,1.6fr) 110px 110px 160px",
                  }}
                >
                  {/* User */}
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium text-foreground truncate">
                      {s.userName ?? s.userEmail}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {s.userName ? s.userEmail : ""}
                    </span>
                  </div>

                  {/* Device */}
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <DeviceIcon kind={s.deviceKind} />
                    <span className="truncate">
                      {extractBrowser(s.userAgent)}
                    </span>
                  </div>

                  {/* IP */}
                  <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                    <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{s.ip ?? "—"}</span>
                  </div>

                  {/* Last active */}
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs text-muted-foreground">
                      {formatTs(s.updatedAt)}
                    </span>
                    <span className="text-[11px] text-muted-foreground/60">
                      Expires {formatTs(s.expiresAt)}
                    </span>
                  </div>

                  {/* Revoke */}
                  {canRevoke && (
                    <div className="flex items-center">
                      {s.userId === session.user.id ? (
                        <Badge variant="muted" className="text-[10px]">
                          Your session
                        </Badge>
                      ) : (
                        <RevokeSessionButton
                          orgSlug={orgSlug}
                          sessionId={s.id}
                          targetUserId={s.userId}
                          userName={s.userName ?? s.userEmail}
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>

      {!canRevoke && (
        <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
          <CircleSlash
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-xs text-muted-foreground">
            Owner or admin role required to revoke sessions.
          </p>
        </div>
      )}
    </div>
  );
}
