/**
 * Sessions tab — static mock UI.
 *
 * Displays active session table (user, device, IP, last-active, location).
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live IAM data in OXA-XXXX (see parent ticket).
 */

import {
  MonitorDot,
  Globe,
  Laptop,
  Smartphone,
  Chrome,
  CircleSlash,
} from "lucide-react";
import {
  Card,
  CardPanel,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

type DeviceKind = "desktop" | "mobile" | "headless";
type SessionStatus = "active" | "revoked" | "expired";

interface MockSession {
  id: string;
  user: string;
  userEmail: string;
  device: DeviceKind;
  browser: string;
  ip: string;
  location: string;
  lastActive: string;
  startedAt: string;
  status: SessionStatus;
  revokeReason: string | null;
}

const MOCK_SESSIONS: MockSession[] = [
  {
    id: "ses_01j9xvpa",
    user: "Mac Anderson",
    userEmail: "mac@oxagen.ai",
    device: "desktop",
    browser: "Chrome 125",
    ip: "192.0.2.14",
    location: "San Francisco, CA",
    lastActive: "Jun 6, 2026 · 10:47 AM",
    startedAt: "Jun 6, 2026 · 08:00 AM",
    status: "active",
    revokeReason: null,
  },
  {
    id: "ses_02j9xvpb",
    user: "Sarah Chen",
    userEmail: "sarah@acme.io",
    device: "desktop",
    browser: "Safari 18",
    ip: "198.51.100.42",
    location: "New York, NY",
    lastActive: "Jun 6, 2026 · 09:55 AM",
    startedAt: "Jun 5, 2026 · 03:22 PM",
    status: "active",
    revokeReason: null,
  },
  {
    id: "ses_03j9xvpc",
    user: "James Park",
    userEmail: "james@acme.io",
    device: "mobile",
    browser: "iOS Safari",
    ip: "203.0.113.77",
    location: "Austin, TX",
    lastActive: "Jun 6, 2026 · 07:30 AM",
    startedAt: "Jun 6, 2026 · 07:28 AM",
    status: "active",
    revokeReason: null,
  },
  {
    id: "ses_04j9xvpd",
    user: "data-sync-worker",
    userEmail: "svc:data-sync-worker",
    device: "headless",
    browser: "API key",
    ip: "10.0.1.5",
    location: "us-central1",
    lastActive: "Jun 6, 2026 · 10:32 AM",
    startedAt: "Jun 1, 2026 · 00:00 AM",
    status: "active",
    revokeReason: null,
  },
  {
    id: "ses_05j9xvpe",
    user: "Lena Brandt",
    userEmail: "lena@acme.io",
    device: "desktop",
    browser: "Firefox 127",
    ip: "203.0.113.199",
    location: "Berlin, DE",
    lastActive: "Jun 4, 2026 · 06:00 PM",
    startedAt: "Jun 4, 2026 · 02:15 PM",
    status: "expired",
    revokeReason: null,
  },
  {
    id: "ses_06j9xvpf",
    user: "Priya Nair",
    userEmail: "priya@acme.io",
    device: "desktop",
    browser: "Chrome 124",
    ip: "198.51.100.88",
    location: "London, UK",
    lastActive: "Jun 3, 2026 · 11:20 AM",
    startedAt: "Jun 3, 2026 · 09:00 AM",
    status: "revoked",
    revokeReason: "Admin revocation — suspicious IP change detected",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function DeviceIcon({ kind }: { kind: DeviceKind }) {
  if (kind === "mobile")
    return (
      <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Mobile" />
    );
  if (kind === "headless")
    return (
      <Chrome className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Headless / API" />
    );
  return (
    <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Desktop" />
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessSessionsPage() {
  const active = MOCK_SESSIONS.filter((s) => s.status === "active");
  const inactive = MOCK_SESSIONS.filter((s) => s.status !== "active");

  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>

      {/* Active sessions */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <MonitorDot
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
            <div>
              <CardTitle>
                Active sessions{" "}
                <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {active.length}
                </span>
              </CardTitle>
              <CardDescription>
                Currently authenticated principals — users, service accounts,
                and API-key sessions.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardPanel>
          {/* Table header (desktop only) */}
          <div className="mb-2 hidden grid-cols-[minmax(0,1.5fr)_120px_110px_130px_160px_80px] gap-4 px-4 sm:grid">
            {["User", "Device", "IP", "Location", "Last active", "Status"].map(
              (h) => (
                <span
                  key={h}
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </span>
              ),
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {active.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </CardPanel>
      </Card>

      {/* Ended sessions */}
      {inactive.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
                <CircleSlash
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </span>
              <div>
                <CardTitle>Ended sessions</CardTitle>
                <CardDescription>
                  Revoked or expired sessions — last 30 days.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardPanel>
            <div className="flex flex-col gap-1.5 opacity-75">
              {inactive.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </div>
          </CardPanel>
        </Card>
      )}
    </div>
  );
}

function SessionRow({ session: s }: { session: MockSession }) {
  const statusBadge =
    s.status === "active" ? (
      <Badge variant="default" className="text-xs">
        Active
      </Badge>
    ) : s.status === "revoked" ? (
      <Badge variant="destructive" className="text-xs">
        <CircleSlash className="mr-1 h-3 w-3" aria-hidden="true" />
        Revoked
      </Badge>
    ) : (
      <Badge variant="muted" className="text-xs">
        Expired
      </Badge>
    );

  return (
    <div
      className="grid rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-sm
        grid-cols-1 gap-y-1
        sm:grid-cols-[minmax(0,1.5fr)_120px_110px_130px_160px_80px] sm:gap-4 sm:items-center"
    >
      {/* User */}
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="font-medium text-foreground truncate">{s.user}</span>
        <span className="text-xs text-muted-foreground truncate">
          {s.userEmail}
        </span>
      </div>

      {/* Device */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <DeviceIcon kind={s.device} />
        <span className="truncate">{s.browser}</span>
      </div>

      {/* IP */}
      <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
        <Globe className="h-3 w-3 shrink-0" aria-hidden="true" />
        {s.ip}
      </div>

      {/* Location */}
      <span className="text-xs text-muted-foreground truncate">
        {s.location}
      </span>

      {/* Last active */}
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">{s.lastActive}</span>
        {s.revokeReason && (
          <span className="text-[11px] text-muted-foreground/60 leading-snug truncate">
            {s.revokeReason}
          </span>
        )}
      </div>

      {/* Status */}
      {statusBadge}
    </div>
  );
}
