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
  initialSlug: string;
  initialAvatarUrl: string;
  /** True when the caller's org role is owner or admin. */
  canEdit: boolean;
  /** Server action with orgSlug already bound; receives only FormData. */
  action: (
    formData: FormData,
  ) => Promise<{ ok: true; slug: string } | { ok: false; error: string }>;
}

// ---------------------------------------------------------------------------
// Slugify — lowercase, drop URL-unsafe characters, spaces → hyphens.
// Mirrors the format enforced by the server action's slug schema so what the
// user sees while typing is exactly what gets persisted.
// ---------------------------------------------------------------------------

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // drop anything that isn't url-safe
    .replace(/\s+/g, "-") // spaces → hyphens
    .replace(/-+/g, "-") // collapse repeated hyphens
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrgGeneralForm({
  orgSlug,
  initialName,
  initialSlug,
  initialAvatarUrl,
  canEdit,
  action,
}: OrgGeneralFormProps): React.JSX.Element {
  const router = useRouter();

  const [name, setName] = React.useState(initialName);
  const [slug, setSlug] = React.useState(initialSlug);
  // avatarUrl is kept as controlled state so the hidden input always reflects
  // the latest value returned by AvatarUpload.onChange.
  const [avatarUrl, setAvatarUrl] = React.useState(initialAvatarUrl);

  // While the slug is empty, keep deriving it from the name as the user types —
  // so an emptied slug refills the moment they edit the name.
  const handleNameChange = (value: string) => {
    setName(value);
    setSlug((prev) => (prev.trim() === "" ? slugify(value) : prev));
  };

  // Focusing the name field while the slug is empty seeds the slug from the
  // current name (covers tabbing back into the name after clearing the slug).
  const handleNameFocus = () => {
    setSlug((prev) => (prev.trim() === "" ? slugify(name) : prev));
  };

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
    formData.set("slug", slug);
    formData.set("avatarUrl", avatarUrl);

    startTransition(async () => {
      const result = await action(formData);
      if (result.ok) {
        setStatus("saved");
        // The slug is the first path segment. If it changed, the current URL is
        // now stale — move to the canonical path for the new slug.
        if (result.slug !== orgSlug) {
          router.replace(`/${result.slug}/settings/general`);
        } else {
          router.refresh();
        }
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
            onChange={(e) => handleNameChange(e.target.value)}
            onFocus={handleNameFocus}
            required
            maxLength={120}
            placeholder="My Organization"
            disabled={isSaving || !canEdit}
          />
        </div>

        {/* Organization slug */}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="org-slug">Slug</Label>
          <Input
            id="org-slug"
            name="slug"
            type="text"
            value={slug}
            onChange={(e) => setSlug(slugify(e.target.value))}
            required
            maxLength={100}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="my-organization"
            className="font-mono"
            disabled={isSaving || !canEdit}
          />
          <p className="text-xs text-muted-foreground">
            Used in your organization&rsquo;s URL. Lowercase letters, numbers,
            and hyphens only. Clear it and edit the name to regenerate it.
          </p>
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
          <Button
            type="submit"
            size="lg"
            disabled={isSaving || !canEdit || !name.trim() || !slug.trim()}
          >
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
