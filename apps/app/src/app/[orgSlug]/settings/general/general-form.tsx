"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AvatarUpload } from "@/components/media/avatar-upload";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrgGeneralFormProps {
  orgSlug: string;
  initialName: string;
  initialAvatarUrl: string;
  /** True when the caller's org role is owner or admin. */
  canEdit: boolean;
  /** Server action with orgSlug already bound; receives only FormData. */
  action: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrgGeneralForm({
  orgSlug,
  initialName,
  initialAvatarUrl,
  canEdit,
  action,
}: OrgGeneralFormProps): React.JSX.Element {
  const router = useRouter();

  const [name, setName] = React.useState(initialName);
  // avatarUrl is kept as controlled state so the hidden input always reflects
  // the latest value returned by AvatarUpload.onChange.
  const [avatarUrl, setAvatarUrl] = React.useState(initialAvatarUrl);

  const [status, setStatus] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const [pending, startTransition] = React.useTransition();
  const isSaving = status === "saving" || pending;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus("saving");
    setErrorMsg(null);

    const formData = new FormData();
    formData.set("name", name);
    formData.set("avatarUrl", avatarUrl);

    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        setStatus("saved");
        router.refresh();
        setTimeout(() => setStatus("idle"), 2000);
      } else {
        setStatus("error");
        setErrorMsg(result.error);
      }
    });
  };

  return (
    <div className="flex max-w-lg flex-col gap-5">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-5"
        aria-label="Organization general settings"
        noValidate
      >
        {/* Organization name */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-name">Organization name</Label>
          <Input
            id="org-name"
            name="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            placeholder="My Organization"
            disabled={isSaving || !canEdit}
          />
        </div>

        {/* Org logo / avatar */}
        <div className="flex flex-col gap-1.5">
          <Label>Logo</Label>
          {/*
            AvatarUpload calls onChange with the blob URL after a successful
            crop+upload. We mirror that value into the hidden input so the
            FormData submitted below always includes the latest avatarUrl.
          */}
          <AvatarUpload
            value={avatarUrl || null}
            onChange={setAvatarUrl}
            fallback={name.charAt(0) || orgSlug.charAt(0)}
            shape="square"
            disabled={isSaving || !canEdit}
          />
          {/* Hidden input carries the resolved URL into FormData on submit. */}
          <input type="hidden" name="avatarUrl" value={avatarUrl} readOnly />
        </div>

        {/* Permission note for viewers */}
        {!canEdit && (
          <p className="text-xs text-muted-foreground" role="note">
            Only organization owners and admins can edit these settings.
          </p>
        )}

        {/* Inline error */}
        {status === "error" && errorMsg && (
          <p className="text-sm text-destructive" role="alert">
            {errorMsg}
          </p>
        )}

        {/* Submit */}
        <div className="flex items-center gap-3 pt-1">
          <Button type="submit" size="lg" disabled={isSaving || !canEdit}>
            {isSaving ? "Saving…" : "Save changes"}
          </Button>
          {status === "saved" && (
            <span className="text-xs text-muted-foreground" role="status">
              Saved
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
