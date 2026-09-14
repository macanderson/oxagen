"use client";
import * as React from "react";
import {
  UserPlus,
  Users,
  Mail,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import type { OrgSeatUsage } from "@oxagen/billing";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
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
import { seatAlert } from "./seat-alert";
import { formatDate } from "@/lib/utils";
import {
  inviteMemberAction,
  declineInvitationAction,
} from "@/app/[orgSlug]/members/actions";
import {
  removeMemberAction,
  changeMemberRoleAction,
} from "@/app/[orgSlug]/members/member-actions";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Member {
  publicId: string;
  displayName: string | null;
  email: string;
  role: string;
  userId: string;
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
  /** The viewing user's role — used for gating mutating controls. */
  viewerRole: string;
  /** The viewing user's own userId — used to prevent self-remove. */
  viewerUserId: string;
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
  const [role, setRole] = React.useState<
    "owner" | "admin" | "member" | "billing"
  >("member");
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
          description:
            "error" in res ? res.error : "An unexpected error occurred.",
          type: "error",
        });
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant={noSeats ? "outline" : "gradient"}
            size="sm"
            className="max-md:h-11"
            startIcon={<UserPlus className="h-3.5 w-3.5" />}
          />
        }
      >
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

          <form
            id="invite-form"
            onSubmit={handleSubmit}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Email address</Label>
              <Input
                id="invite-email"
                type="email"
                className="max-md:h-11"
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
                <SelectTrigger id="invite-role" className="max-md:h-11">
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

        <DialogFooter className="flex-wrap">
          <DialogClose
            render={<Button variant="ghost" className="max-md:h-11" />}
          >
            Cancel
          </DialogClose>
          <Button
            type="submit"
            form="invite-form"
            className="max-md:h-11"
            disabled={pending || noSeats}
          >
            {pending ? "Sending…" : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── RemoveMemberDialog ────────────────────────────────────────────────────────
// Destructive action — always requires confirmation per [[conversation-history-nav]].

function RemoveMemberDialog({
  orgSlug,
  member,
  onRemoved,
}: {
  orgSlug: string;
  member: Member;
  onRemoved: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const { add: addToast } = useToast();

  function handleConfirm() {
    startTransition(async () => {
      const res = await removeMemberAction({
        orgSlug,
        targetUserId: member.userId,
      });
      if (res.ok) {
        addToast({
          title: "Member removed",
          description: `${member.displayName ?? member.email} has been removed from the org.`,
          type: "success",
        });
        setOpen(false);
        onRemoved();
      } else {
        addToast({
          title: "Failed to remove member",
          description: res.error,
          type: "error",
        });
        setOpen(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="max-md:h-11 max-md:w-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
          />
        }
      >
        <Trash2 className="h-3.5 w-3.5" />
        <span className="sr-only">Remove</span>
      </DialogTrigger>

      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Remove member</DialogTitle>
          <DialogDescription>
            This will permanently remove{" "}
            <span className="font-medium">
              {member.displayName ?? member.email}
            </span>{" "}
            from the org and revoke their access. This action cannot be undone
            without sending a new invitation.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="flex-wrap">
          <DialogClose
            render={<Button variant="ghost" className="max-md:h-11" />}
          >
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            className="max-md:h-11"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Removing…" : "Remove member"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ── RoleSelector ─────────────────────────────────────────────────────────────
// Inline role select for privileged users. Shows current role; on change
// calls changeMemberRoleAction immediately (no separate confirm step — role
// changes are reversible, unlike removes).

const ORG_ROLES = [
  "Owner",
  "Admin",
  "Member",
  "Billing",
  "Compliance",
] as const;
type OrgRoleName = (typeof ORG_ROLES)[number];

function RoleSelector({
  orgSlug,
  member,
  onChanged,
}: {
  orgSlug: string;
  member: Member;
  onChanged: (newRole: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const { add: addToast } = useToast();

  function handleChange(newRole: string | null) {
    if (!newRole || newRole === member.role) return;
    startTransition(async () => {
      const res = await changeMemberRoleAction({
        orgSlug,
        targetUserId: member.userId,
        newRole,
      });
      if (res.ok) {
        onChanged(newRole);
        addToast({
          title: "Role updated",
          description: `${member.displayName ?? member.email} is now ${newRole}.`,
          type: "success",
        });
      } else {
        addToast({
          title: "Failed to update role",
          description: res.error,
          type: "error",
        });
      }
    });
  }

  return (
    <Select value={member.role} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger
        className="h-7 min-w-[7rem] text-xs max-md:h-11"
        aria-label={`Change role for ${member.displayName ?? member.email}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {ORG_ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {r}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

// ── MemberRow ─────────────────────────────────────────────────────────────────

function MemberRow({
  orgSlug,
  member: initialMember,
  canManage,
  isSelf,
  onRemoved,
}: {
  orgSlug: string;
  member: Member;
  canManage: boolean;
  isSelf: boolean;
  onRemoved: () => void;
}) {
  // Local role state so the RoleSelector update is optimistic without a full
  // RSC re-render (revalidatePath kicks in as the background refresh).
  const [role, setRole] = React.useState(initialMember.role);
  const member = { ...initialMember, role };

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col">
        <span className="font-medium">
          {member.displayName ?? member.email}
        </span>
        <span className="text-xs text-muted-foreground">{member.email}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canManage && !isSelf ? (
          <>
            {/* Inline role selector for privileged users */}
            <RoleSelector
              orgSlug={orgSlug}
              member={member}
              onChanged={(newRole) => setRole(newRole as OrgRoleName)}
            />
            {/* Destructive remove button with confirm dialog */}
            <RemoveMemberDialog
              orgSlug={orgSlug}
              member={member}
              onRemoved={onRemoved}
            />
          </>
        ) : (
          /* Non-privileged users see a read-only badge */
          <Badge variant="outline">{member.role}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Joined {formatDate(member.joinedAt)}
        </span>
      </div>
    </li>
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
      const res = await declineInvitationAction({
        orgSlug,
        invitationPublicId: publicId,
      });
      if (res.ok) {
        addToast({
          title: "Invitation revoked",
          description: email,
          type: "success",
        });
      } else {
        addToast({
          title: "Failed to revoke invitation",
          description: res.error,
          type: "error",
        });
      }
    });
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
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
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
                className="max-md:h-11 max-md:self-start"
                onClick={() => handleDecline(inv.publicId, inv.email)}
                disabled={declining}
              >
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ── MembersPanel ──────────────────────────────────────────────────────────────

const CAN_MANAGE_MEMBERS = new Set(["owner", "admin", "Owner", "Admin"]);

export function MembersPanel({
  orgSlug,
  members: initialMembers,
  pendingInvitations,
  seatUsage,
  viewerRole,
  viewerUserId,
}: MembersPanelProps) {
  // Local member list so removals optimistically drop the row without waiting
  // for a full RSC refresh (revalidatePath triggers the background sync).
  const [members, setMembers] = React.useState(initialMembers);
  const canManage = CAN_MANAGE_MEMBERS.has(viewerRole);

  function handleRemoved(userId: string) {
    setMembers((prev) => prev.filter((m) => m.userId !== userId));
  }

  return (
    <div className="flex flex-col gap-6">
      <SeatAlertBanner orgSlug={orgSlug} seatUsage={seatUsage} />

      <Panel
        title={
          <>
            Organization members
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {members.length} / {seatUsage.licenses}
            </span>
          </>
        }
        actions={
          canManage ? (
            <AddMemberDialog orgSlug={orgSlug} seatUsage={seatUsage} />
          ) : undefined
        }
      >
        {members.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title="No members yet"
            description="Invite teammates to collaborate in this organization."
            action={
              canManage ? (
                <AddMemberDialog orgSlug={orgSlug} seatUsage={seatUsage} />
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {members.map((m) => (
              <MemberRow
                key={m.publicId}
                orgSlug={orgSlug}
                member={m}
                canManage={canManage}
                isSelf={m.userId === viewerUserId}
                onRemoved={() => handleRemoved(m.userId)}
              />
            ))}
          </ul>
        )}
      </Panel>

      <PendingInvitationsList
        orgSlug={orgSlug}
        invitations={pendingInvitations}
        canManage={canManage}
      />
    </div>
  );
}
