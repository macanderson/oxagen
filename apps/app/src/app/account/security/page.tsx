/**
 * Account → Security: the user's own security posture.
 *
 * Shows:
 *   1. TOTP MFA — live enrollment / management via Better Auth's twoFactor
 *      plugin (enable, verify, disable, regenerate backup codes).
 *   2. Active sessions — all sessions tied to this user, with revoke-other.
 *
 * This is user-scoped (not org-scoped). No RBAC gate — users can always see
 * and manage their own sessions and 2FA.
 */

import { Laptop, Smartphone, Bot, Globe } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { and, eq, gt } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { getSessionOrRedirect } from "@/lib/session";
import { RevokeOwnSessionButton } from "./_components/revoke-own-session-button";
import TotpEnrollmentCard from "./_components/totp-enrollment-card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DeviceKind = "desktop" | "mobile" | "headless";

interface UserSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  deviceKind: DeviceKind;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function extractBrowser(ua: string | null): string {
  if (!ua) return "Unknown";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg")) return "Edge";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  return ua.slice(0, 40);
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

async function loadUserSessions(userId: string): Promise<UserSession[]> {
  const now = new Date();
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.sessions.id,
        userAgent: schema.sessions.userAgent,
        ip: schema.sessions.ipAddress,
        createdAt: schema.sessions.createdAt,
        updatedAt: schema.sessions.updatedAt,
        expiresAt: schema.sessions.expiresAt,
      })
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.userId, userId),
          gt(schema.sessions.expiresAt, now),
        ),
      )
      .orderBy(schema.sessions.updatedAt),
  );

  return rows.map((r) => ({
    id: r.id,
    userAgent: r.userAgent,
    ip: r.ip,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: r.expiresAt,
    deviceKind: classifyDevice(r.userAgent),
  }));
}

/** Read the user's TOTP enrollment flag (auth.users.two_factor_enabled). */
async function loadTwoFactorEnabled(userId: string): Promise<boolean> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({ enabled: schema.users.twoFactorEnabled })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1),
  );
  return rows[0]?.enabled ?? false;
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
      aria-label="Desktop browser"
    />
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function AccountSecurityPage() {
  const session = await getSessionOrRedirect();

  const [sessions, twoFactorEnabled] = await Promise.all([
    loadUserSessions(session.user.id),
    loadTwoFactorEnabled(session.user.id),
  ]);

  const currentSessionId = session.session?.id ?? null;

  return (
    <div className="flex flex-col gap-6">
      {/* Heading matches the sibling account pages (Preferences/Privacy). */}
      <PageHeader
        title="Security"
        description="Two-factor authentication and active sessions."
      />

      {/* MFA — live TOTP enrollment / management. */}
      <TotpEnrollmentCard enabled={twoFactorEnabled} />

      {/* Active sessions */}
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
          All active sessions for your account. You can revoke any session you
          do not recognize.
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
                gridTemplateColumns: "minmax(0,1.4fr) 100px 120px 160px 140px",
              }}
            >
              {["Device", "IP", "Started", "Last active", ""].map((h) => (
                <span
                  key={h}
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </span>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              {sessions.map((s) => {
                const isCurrent =
                  currentSessionId !== null && s.id === currentSessionId;
                return (
                  <div
                    key={s.id}
                    // The 5-column template must stay an sm+-scoped arbitrary
                    // property, not an inline style: an inline style beats
                    // `grid-cols-1` at every breakpoint, laying phone rows out
                    // ~660px wide and clipping the timestamp/revoke columns.
                    className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-sm grid grid-cols-1 gap-y-1 sm:gap-4 sm:items-center sm:[grid-template-columns:minmax(0,1.4fr)_100px_120px_160px_140px]"
                  >
                    {/* Device */}
                    <div className="flex items-center gap-1.5 min-w-0">
                      <DeviceIcon kind={s.deviceKind} />
                      <span className="text-xs text-muted-foreground truncate">
                        {extractBrowser(s.userAgent)}
                      </span>
                      {isCurrent && (
                        <Badge
                          variant="success"
                          className="ml-1 text-[10px] shrink-0"
                        >
                          Current
                        </Badge>
                      )}
                    </div>

                    {/* IP */}
                    <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                      <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{s.ip ?? "—"}</span>
                    </div>

                    {/* Started */}
                    <span className="text-xs text-muted-foreground">
                      {formatTs(s.createdAt)}
                    </span>

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
                    <div className="flex items-center">
                      {isCurrent ? (
                        <Badge variant="muted" className="text-[10px]">
                          This session
                        </Badge>
                      ) : (
                        <RevokeOwnSessionButton sessionId={s.id} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
