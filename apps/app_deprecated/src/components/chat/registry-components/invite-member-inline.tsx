"use client";

import * as React from "react";
import { UserPlus, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { inviteMemberAction } from "@/app/[orgSlug]/members/actions";
import { cn } from "@/lib/utils";

export interface InviteMemberInlineProps {
  orgSlug?: string;
  workspaceSlug?: string;
  /** Pre-filled email from agent inference */
  suggestedEmail?: string;
}

type FormState = "idle" | "submitting" | "success" | "error";

type MemberRole = "owner" | "admin" | "member" | "billing";

export default function InviteMemberInline({
  orgSlug = "",
  suggestedEmail = "",
}: InviteMemberInlineProps): React.ReactElement {
  const [email, setEmail] = React.useState(suggestedEmail);
  const [role, setRole] = React.useState<MemberRole>("member");
  const [formState, setFormState] = React.useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const emailId = React.useId();
  const roleId = React.useId();

  const isSubmitting = formState === "submitting";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    const result = await inviteMemberAction({ orgSlug, email, role });

    if (result.ok) {
      setFormState("success");
    } else {
      setErrorMessage("error" in result ? result.error : "Invitation failed");
      setFormState("error");
    }
  }

  if (formState === "success") {
    return (
      <div
        className={cn("rounded-2xl border border-border bg-card p-5 space-y-3")}
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-3">
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-success"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Invitation sent
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {email} · {role}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Invite member"
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-5 w-full max-w-sm",
      )}
    >
      <div className="flex items-center gap-2.5">
        <UserPlus
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Invite member
        </span>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={emailId}>Email</Label>
        <Input
          id={emailId}
          name="email"
          type="email"
          required
          placeholder="teammate@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={isSubmitting}
          autoComplete="email"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={roleId}>Role</Label>
        <Select
          value={role}
          onValueChange={(v) => {
            if (v !== null) setRole(v as MemberRole);
          }}
          disabled={isSubmitting}
          name="role"
        >
          <SelectTrigger id={roleId} aria-label="Member role">
            <SelectValue placeholder="Select role" />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="member">Member</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="owner">Owner</SelectItem>
            <SelectItem value="billing">Billing</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      {formState === "error" && errorMessage !== null && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSubmitting || email.trim() === ""}
        className="w-full"
        aria-busy={isSubmitting}
      >
        {isSubmitting ? "Sending invite…" : "Send invitation"}
      </Button>
    </form>
  );
}
