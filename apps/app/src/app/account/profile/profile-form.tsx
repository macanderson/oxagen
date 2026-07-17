"use client";
import * as React from "react";
import Link from "next/link";
import { useRegisterFillableForm } from "@/lib/page-context";
import { FieldFillTransition } from "@/components/ui/field-fill-transition";
import { AvatarMaker } from "@/components/avatar/avatar-maker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { updateProfileAction, type ProfileInput } from "./profile-action";
import { ConnectedAccounts } from "./connected-accounts";
import { SetPasswordForm } from "./set-password-form";
import type { FillableFormSpec, FieldDescriptor } from "@/lib/ask/fill-types";
import type { ConnectedAccountsState } from "./security-types";
import { account } from "@/lib/routes";

export interface ProfileFormProps {
  userId: string;
  initialDisplayName: string;
  email: string;
  initialAvatarUrl: string;
  connectedAccountsState: ConnectedAccountsState;
  timezone: string;
  language: string;
}

export function ProfileForm({
  userId,
  initialDisplayName,
  email,
  initialAvatarUrl,
  connectedAccountsState,
  timezone,
  language,
}: ProfileFormProps) {
  const [displayName, setDisplayName] = React.useState(initialDisplayName);
  const [avatarUrl, setAvatarUrl] = React.useState(initialAvatarUrl);
  const [status, setStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  // Ask-to-Fill registration — lets the AI suggest profile values
  const fields: FieldDescriptor[] = [
    {
      name: "displayName",
      label: "Display name",
      type: "text",
      current: displayName,
      required: true,
    },
    {
      name: "avatarUrl",
      label: "Avatar URL",
      type: "text",
      current: avatarUrl,
      required: false,
    },
  ];

  const spec: FillableFormSpec = {
    formId: `account-profile-${userId}`,
    title: "Profile",
    fields,
  };

  useRegisterFillableForm({
    ...spec,
    apply: (values: Record<string, unknown>, mode, fieldName) => {
      if (mode === "field" && fieldName === "displayName") {
        if (typeof values.displayName === "string") setDisplayName(values.displayName);
      } else if (mode === "field" && fieldName === "avatarUrl") {
        if (typeof values.avatarUrl === "string") setAvatarUrl(values.avatarUrl);
      } else {
        if (typeof values.displayName === "string") setDisplayName(values.displayName);
        if (typeof values.avatarUrl === "string") setAvatarUrl(values.avatarUrl);
      }
    },
  });

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setStatus("saving");
    setErrorMsg(null);

    const input: ProfileInput = {
      displayName,
      avatarUrl: avatarUrl || undefined,
    };

    const result = await updateProfileAction(input);
    if (result.ok) {
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } else {
      setStatus("error");
      setErrorMsg(result.error);
    }
  };

  const isSaving = status === "saving";

  return (
    <div className="flex max-w-lg flex-col gap-5">
      {/* Profile fields form — submits only display name + avatar */}
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-5"
        aria-label="Profile settings"
        noValidate
      >
        {/* Email — read-only */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-email">Email</Label>
          <Input
            id="profile-email"
            type="email"
            value={email}
            readOnly
            disabled
            autoComplete="email"
            aria-readonly="true"
            className="cursor-not-allowed opacity-60"
          />
          <p className="text-xs text-muted-foreground">
            Email address cannot be changed here. Contact support to update your email.
          </p>
        </div>

        {/* Display name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-display-name">Display name</Label>
          <FieldFillTransition active={status === "saving"}>
            <Input
              id="profile-display-name"
              name="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={120}
              autoComplete="name"
              placeholder="Your name"
              disabled={isSaving}
            />
          </FieldFillTransition>
        </div>

        {/* Avatar — photo upload+crop OR a designed emoji/color avatar. Either
            result flows through the same `avatarUrl` state the save action
            persists (and Ask-to-Fill sets). */}
        <div className="flex flex-col gap-1.5">
          <Label>Avatar</Label>
          <AvatarMaker
            value={avatarUrl || null}
            onChange={setAvatarUrl}
            name={displayName || email}
            shape="circle"
            entityLabel="profile"
            disabled={isSaving}
          />
        </div>

        {/* Timezone + language — read-only key/value, not editable inputs. These
            are owned by the Preferences page, so we show the current values as
            plain text (a disabled input reads as "editable but broken") and link
            out to where they're actually changed. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Regional</span>
          <dl className="divide-y divide-border rounded-md border border-border">
            <div className="flex items-center justify-between gap-4 px-3 py-2">
              <dt className="text-sm text-muted-foreground">Timezone</dt>
              <dd className="text-sm font-medium tabular-nums text-foreground">
                {timezone.replace(/_/g, " ")}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-3 py-2">
              <dt className="text-sm text-muted-foreground">Language</dt>
              <dd className="text-sm font-medium text-foreground">{language}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Timezone and language can be changed in{" "}
            <Link href={account.preferences()} className="underline underline-offset-2">
              Preferences
            </Link>
            .
          </p>
        </div>

        {/* Errors */}
        {status === "error" && errorMsg && (
          <p className="text-sm text-destructive" role="alert">
            {errorMsg}
          </p>
        )}

        {/* Save button */}
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save changes"}
          </Button>
          {status === "saved" && (
            <span className="text-xs text-muted-foreground" role="status">
              Saved
            </span>
          )}
        </div>
      </form>

      {/* Divider */}
      <hr className="border-border" />

      {/* Connected accounts — sibling of both forms, not inside either */}
      <ConnectedAccounts state={connectedAccountsState} />

      {/* Set password — only when no password exists yet; sibling form, never nested */}
      {!connectedAccountsState.hasPassword && (
        <>
          <hr className="border-border" />
          <SetPasswordForm />
        </>
      )}
    </div>
  );
}
