/**
 * Identities tab — static mock UI.
 *
 * Displays principal identities: users, service accounts, API-key principals.
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live IAM data in OXA-XXXX (see parent ticket).
 */

import {
  Fingerprint,
  Bot,
  User,
  Cpu,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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

type PrincipalKind = "human" | "agent" | "service" | "api_key";
type PrincipalStatus = "active" | "suspended" | "deleted";
type MfaStatus = "none" | "totp" | "passkey" | "sms";

interface MockPrincipal {
  id: string;
  kind: PrincipalKind;
  displayName: string;
  email: string | null;
  status: PrincipalStatus;
  mfaStatus: MfaStatus;
  idpSubject: string | null;
  role: string;
  createdAt: string;
  lastActiveAt: string | null;
}

const MOCK_PRINCIPALS: MockPrincipal[] = [
  {
    id: "prn_01j9xwua",
    kind: "human",
    displayName: "Mac Anderson",
    email: "mac@oxagen.ai",
    status: "active",
    mfaStatus: "passkey",
    idpSubject: "google|114835920281934726583",
    role: "Owner",
    createdAt: "May 28, 2026",
    lastActiveAt: "Jun 6, 2026",
  },
  {
    id: "prn_02j9xwub",
    kind: "human",
    displayName: "Sarah Chen",
    email: "sarah@acme.io",
    status: "active",
    mfaStatus: "totp",
    idpSubject: "google|102938475610293847561",
    role: "Admin",
    createdAt: "May 29, 2026",
    lastActiveAt: "Jun 6, 2026",
  },
  {
    id: "prn_03j9xwuc",
    kind: "human",
    displayName: "James Park",
    email: "james@acme.io",
    status: "active",
    mfaStatus: "totp",
    idpSubject: null,
    role: "Billing",
    createdAt: "May 30, 2026",
    lastActiveAt: "Jun 6, 2026",
  },
  {
    id: "prn_04j9xwud",
    kind: "human",
    displayName: "Priya Nair",
    email: "priya@acme.io",
    status: "active",
    mfaStatus: "none",
    idpSubject: null,
    role: "Member",
    createdAt: "Jun 1, 2026",
    lastActiveAt: "Jun 5, 2026",
  },
  {
    id: "prn_05j9xwue",
    kind: "human",
    displayName: "Lena Brandt",
    email: "lena@acme.io",
    status: "suspended",
    mfaStatus: "none",
    idpSubject: null,
    role: "Viewer",
    createdAt: "Jun 2, 2026",
    lastActiveAt: "Jun 4, 2026",
  },
  {
    id: "prn_06j9xwuf",
    kind: "service",
    displayName: "data-sync-worker",
    email: null,
    status: "active",
    mfaStatus: "none",
    idpSubject: "svc:data-sync-worker",
    role: "Member",
    createdAt: "Jun 1, 2026",
    lastActiveAt: "Jun 6, 2026",
  },
  {
    id: "prn_07j9xwug",
    kind: "agent",
    displayName: "research-agent-v2",
    email: null,
    status: "active",
    mfaStatus: "none",
    idpSubject: "agent:research-agent-v2",
    role: "Member",
    createdAt: "Jun 2, 2026",
    lastActiveAt: "Jun 5, 2026",
  },
  {
    id: "prn_08j9xwuh",
    kind: "api_key",
    displayName: "CI deploy token",
    email: null,
    status: "active",
    mfaStatus: "none",
    idpSubject: "key:ci-deploy-token",
    role: "Member",
    createdAt: "Jun 3, 2026",
    lastActiveAt: "Jun 6, 2026",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KIND_ICON: Record<PrincipalKind, LucideIcon> = {
  human: User,
  agent: Bot,
  service: Cpu,
  api_key: KeyRound,
};

const KIND_LABEL: Record<PrincipalKind, string> = {
  human: "User",
  agent: "Agent",
  service: "Service",
  api_key: "API key",
};

const STATUS_VARIANT: Record<
  PrincipalStatus,
  "default" | "muted" | "destructive"
> = {
  active: "default",
  suspended: "muted",
  deleted: "destructive",
};

const MFA_LABEL: Record<MfaStatus, string> = {
  none: "No MFA",
  totp: "TOTP",
  passkey: "Passkey",
  sms: "SMS",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessIdentitiesPage() {
  const humans = MOCK_PRINCIPALS.filter((p) => p.kind === "human");
  const nonHumans = MOCK_PRINCIPALS.filter((p) => p.kind !== "human");

  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>

      {/* Human principals */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <Fingerprint
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
            <div>
              <CardTitle>User identities</CardTitle>
              <CardDescription>
                Human principals — org members authenticated via email/password
                or SSO.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardPanel>
          {/* Header row — desktop only */}
          <div className="mb-2 hidden grid-cols-[minmax(0,1.5fr)_120px_80px_90px_120px_100px] gap-4 px-4 sm:grid">
            {["Identity", "Email / IDP", "Role", "Status", "MFA", "Last active"].map(
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
            {humans.map((p) => (
              <PrincipalRow key={p.id} principal={p} />
            ))}
          </div>
        </CardPanel>
      </Card>

      {/* Non-human principals */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <Bot
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
            <div>
              <CardTitle>Service &amp; agent identities</CardTitle>
              <CardDescription>
                Non-human principals — agents, service accounts, and API-key
                tokens registered in this organization.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardPanel>
          {/* Header row — desktop only */}
          <div className="mb-2 hidden grid-cols-[minmax(0,1.5fr)_120px_80px_90px_120px_100px] gap-4 px-4 sm:grid">
            {["Identity", "Subject", "Role", "Status", "Kind", "Last active"].map(
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
            {nonHumans.map((p) => (
              <PrincipalRow key={p.id} principal={p} />
            ))}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}

function PrincipalRow({ principal: p }: { principal: MockPrincipal }) {
  const KindIcon = KIND_ICON[p.kind];
  const isHuman = p.kind === "human";

  return (
    <div
      className="grid rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-sm
        grid-cols-1 gap-y-1
        sm:grid-cols-[minmax(0,1.5fr)_120px_80px_90px_120px_100px] sm:gap-4 sm:items-center"
    >
      {/* Identity */}
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/60">
          <KindIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-medium text-foreground truncate">
            {p.displayName}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {KIND_LABEL[p.kind]} &middot; {p.createdAt}
          </span>
        </div>
      </div>

      {/* Email or IDP subject */}
      <span className="font-mono text-xs text-muted-foreground truncate">
        {p.email ?? p.idpSubject ?? "—"}
      </span>

      {/* Role */}
      <Badge variant="outline" className="w-fit text-xs">
        {p.role}
      </Badge>

      {/* Status */}
      <Badge variant={STATUS_VARIANT[p.status]} className="w-fit text-xs capitalize">
        {p.status}
      </Badge>

      {/* MFA / Kind */}
      {isHuman ? (
        p.mfaStatus === "none" ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            No MFA
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-green-500" aria-hidden="true" />
            {MFA_LABEL[p.mfaStatus]}
          </span>
        )
      ) : (
        <Badge variant="outline" className="w-fit text-xs">
          {KIND_LABEL[p.kind]}
        </Badge>
      )}

      {/* Last active */}
      <span className="text-xs text-muted-foreground">
        {p.lastActiveAt ?? "Never"}
      </span>
    </div>
  );
}
