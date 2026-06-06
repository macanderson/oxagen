import { Mail, Clock } from "lucide-react";
import { Card, CardPanel, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Static mock — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface MockInvitation {
  id: string;
  email: string;
  role: "owner" | "admin" | "member" | "billing";
  invitedBy: string;
  expiresAt: string;
}

const MOCK_INVITATIONS: MockInvitation[] = [
  {
    id: "inv_01",
    email: "jordan.lee@acme.io",
    role: "admin",
    invitedBy: "Mac Anderson",
    expiresAt: "2026-06-13T10:00:00Z",
  },
  {
    id: "inv_02",
    email: "priya.sharma@acme.io",
    role: "member",
    invitedBy: "Mac Anderson",
    expiresAt: "2026-06-11T15:30:00Z",
  },
  {
    id: "inv_03",
    email: "tom.baker@partner.com",
    role: "billing",
    invitedBy: "Mac Anderson",
    expiresAt: "2026-06-10T09:00:00Z",
  },
];

function formatExpiry(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Expires today";
  if (days === 1) return "Expires tomorrow";
  return `Expires in ${days} days`;
}

const ROLE_VARIANT: Record<
  MockInvitation["role"],
  "default" | "secondary" | "outline"
> = {
  owner:   "default",
  admin:   "default",
  member:  "secondary",
  billing: "outline",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function MembersPendingPage() {
  if (MOCK_INVITATIONS.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-border/60 bg-muted/30 px-6 py-16 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Mail className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">No pending invitations</p>
          <p className="text-xs text-muted-foreground">
            Members who have been invited but have not yet accepted will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Preview pill */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        Preview · not yet wired to live data
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            Pending invitations
            <Badge variant="secondary">{MOCK_INVITATIONS.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardPanel>
          <ul className="divide-y divide-border/60">
            {MOCK_INVITATIONS.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4"
              >
                {/* Avatar placeholder */}
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted text-xs font-medium text-muted-foreground uppercase">
                  {inv.email.charAt(0)}
                </span>

                {/* Email + meta */}
                <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium text-foreground truncate">{inv.email}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                    {formatExpiry(inv.expiresAt)} · Invited by {inv.invitedBy}
                  </span>
                </div>

                {/* Role + action */}
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={ROLE_VARIANT[inv.role]} className="capitalize text-xs">
                    {inv.role}
                  </Badge>
                  <Button variant="ghost" size="sm" disabled aria-label={`Resend invitation to ${inv.email}`}>
                    Resend
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled
                    aria-label={`Revoke invitation for ${inv.email}`}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </CardPanel>
      </Card>
    </div>
  );
}
