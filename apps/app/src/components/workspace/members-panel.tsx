"use client";
import * as React from "react";
import { UserPlus, Mail, AlertCircle, CheckCircle2, AlertTriangle } from "lucide-react";
import type { OrgSeatUsage } from "@oxagen/billing";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { seatAlert } from "@/lib/seat-alert";
import { formatDate } from "@/lib/utils";
import { inviteMemberAction, declineInvitationAction } from "@/app/[orgSlug]/members/actions";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Member {
  publicId: string;
  displayName: string | null;
  email: string;
  role: string;
  joinedAt: Date | string | null;
}

export interface PendingInvitation {
  publicId: string;
  email: string;
  role: string;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface MembersPanelProps {
  orgSlug: string;
  members: Member[];
  pendingInvitations: PendingInvitation[];
  seatUsage: OrgSeatUsage;
  /** The viewing user's role — used for gating Add-member controls. */
  viewerRole: string;
}

// ── SeatAlertBanner ───────────────────────────────────────────────────────────

function SeatAlertBanner({
  orgSlug,
  seatUsage,
}: {
  orgSlug: string;
  seatUsage: OrgSeatUsage;
}) {
  const alert = seatAlert(seatUsage, orgSlug);

  const Icon =
    alert.variant === "error"
      ? AlertCircle
      : alert.variant === "warning"
        ? AlertTriangle
        : CheckCircle2;

  return (
    <Alert variant={alert.variant}>
      <Icon />
      <AlertTitle>{alert.title}</AlertTitle>
      <AlertDescription>
        {alert.body}
        {alert.cta ? (
          <>
            {" "}
            <a
              href={alert.cta.href}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              {alert.cta.label}
            </a>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

// ── AddMemberDialog ───────────────────────────────────────────────────────────

function AddMemberDialog({
  orgSlug,
  seatUsage,
}: {
  orgSlug: string;
  seatUsage: OrgSeatUsage;
}) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<"owner" | "admin" | "member" | "billing">("member");
  const [pending, startTransition] = React.useTransition();
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const { add: addToast } = useToast();

  const noSeats = seatUsage.available <= 0;
  const billingHref = `/${orgSlug}/billing/subscription`;

  function reset() {
    setEmail("");
    setRole("member");
    setFieldError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) {
      setFieldError("Email is required.");
      return;
    }
    setFieldError(null);
    startTransition(async () => {
      const res = await inviteMemberAction({ orgSlug, email, role });
      if (res.ok) {
        addToast({
          title: "Invitation sent",
          description: `${email} has been invited as ${role}.`,
          type: "success",
        });
        reset();
        setOpen(false);
      } else if (res.code === "seat_limit_reached") {
        setFieldError(
          `No licenses available. Increase your seat count on Billing before inviting teammates.`,
        );
      } else if (res.code === "already_invited") {
        setFieldError(res.error);
      } else {
        addToast({
          title: "Failed to send invitation",
          description: "error" in res ? res.error : "An unexpected error occurred.",
          type: "error",
        });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger
        render={
          <Button
            variant={noSeats ? "outline" : "default"}
            size="sm"
            disabled={false}
          />
        }
      >
        <UserPlus className="mr-1.5 h-3.5 w-3.5" />
        Add member
      </DialogTrigger>

      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            An email invitation will be sent. The invite link expires in 7 days.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {noSeats ? (
            <Alert variant="warning" className="mb-4">
              <AlertTriangle />
              <AlertTitle>No licenses available</AlertTitle>
              <AlertDescription>
                You need to{" "}
                <a
                  href={billingHref}
                  className="font-medium underline underline-offset-2"
                  onClick={() => setOpen(false)}
                >
                  increase your seat count on Billing
                </a>{" "}
                before inviting teammates.
              </AlertDescription>
            </Alert>
          ) : null}

          <form id="invite-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="teammate@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={pending}
                autoComplete="email"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as typeof role)}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="billing">Billing</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                </SelectPopup>
              </Select>
            </div>

            {fieldError ? (
              <p className="text-sm text-destructive">{fieldError}</p>
            ) : null}
          </form>
        </DialogPanel>

        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            type="submit"
            form="invite-form"
            disabled={pending || noSeats}
          >
            {pending ? "Sending…" : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── PendingInvitationsList ────────────────────────────────────────────────────

function PendingInvitationsList({
  orgSlug,
  invitations,
  canManage,
}: {
  orgSlug: string;
  invitations: PendingInvitation[];
  canManage: boolean;
}) {
  const [declining, startDecline] = React.useTransition();
  const { add: addToast } = useToast();

  if (invitations.length === 0) return null;

  function handleDecline(publicId: string, email: string) {
    startDecline(async () => {
      const res = await declineInvitationAction({ orgSlug, invitationPublicId: publicId });
      if (res.ok) {
        addToast({ title: "Invitation revoked", description: email, type: "success" });
      } else {
        addToast({ title: "Failed to revoke invitation", description: res.error, type: "error" });
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Pending invitations
          <Badge variant="secondary">{invitations.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardPanel>
        <ul className="divide-y divide-border/60">
          {invitations.map((inv) => (
            <li key={inv.publicId} className="flex items-center justify-between py-3">
              <div className="flex flex-col">
                <span className="font-medium">{inv.email}</span>
                <span className="text-xs text-muted-foreground">
                  Invited as {inv.role}
                  {inv.expiresAt ? ` · Expires ${formatDate(inv.expiresAt)}` : ""}
                </span>
              </div>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDecline(inv.publicId, inv.email)}
                  disabled={declining}
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardPanel>
    </Card>
  );
}

// ── MembersPanel ──────────────────────────────────────────────────────────────

const CAN_MANAGE_MEMBERS = new Set(["owner", "admin"]);

export function MembersPanel({
  orgSlug,
  members,
  pendingInvitations,
  seatUsage,
  viewerRole,
}: MembersPanelProps) {
  const canManage = CAN_MANAGE_MEMBERS.has(viewerRole);

  return (
    <div className="flex flex-col gap-6">
      <SeatAlertBanner orgSlug={orgSlug} seatUsage={seatUsage} />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>
              Organization members
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {members.length} / {seatUsage.licenses}
              </span>
            </CardTitle>
            {canManage ? (
              <AddMemberDialog orgSlug={orgSlug} seatUsage={seatUsage} />
            ) : null}
          </div>
        </CardHeader>
        <CardPanel>
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {members.map((m) => (
                <li key={m.publicId} className="flex items-center justify-between py-3">
                  <div className="flex flex-col">
                    <span className="font-medium">{m.displayName ?? m.email}</span>
                    <span className="text-xs text-muted-foreground">{m.email}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline">{m.role}</Badge>
                    <span className="text-xs text-muted-foreground">
                      Joined {formatDate(m.joinedAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardPanel>
      </Card>

      <PendingInvitationsList
        orgSlug={orgSlug}
        invitations={pendingInvitations}
        canManage={canManage}
      />
    </div>
  );
}
