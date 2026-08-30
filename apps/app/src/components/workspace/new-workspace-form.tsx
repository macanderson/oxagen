"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface NewWorkspaceAction {
  (
    formData: FormData,
  ): Promise<
    { ok: true; workspaceSlug: string } | { ok: false; error: string }
  >;
}

// Slug rules mirror the workspace.create contract pattern: [a-z0-9-]{2,40}.
// Identical to deriveSlug in new-organization-form.tsx — strip unsafe chars,
// spaces → hyphens, lowercase, so the result is a url-safe slug resembling
// the workspace name.
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function NewWorkspaceForm({
  orgSlug,
  action,
}: {
  orgSlug: string;
  action: NewWorkspaceAction;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  // The slug auto-follows the name until the user hand-edits it to a non-empty
  // value. Clearing the slug field back to empty re-arms auto-population, so an
  // empty slug + a name change always repopulates the slug.
  const slugManuallyEdited = React.useRef(false);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Hard navigation into the new workspace — NOT router.push + refresh in one
      // transition (that race hangs the transition; see new-organization-form).
      // A full assign also guarantees the org layout re-fetches availableWorkspaces
      // so the new workspace appears in the switcher.
      window.location.assign(`/${orgSlug}/${res.workspaceSlug}`);
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="ws-name">Workspace name</Label>
        <Input
          id="ws-name"
          name="name"
          required
          maxLength={120}
          placeholder="Production"
          value={name}
          onChange={(e) => {
            const next = e.target.value;
            setName(next);
            // Auto-populate while the user hasn't overridden the slug, and also
            // whenever the slug is currently empty (re-armed override).
            if (!slugManuallyEdited.current || slug === "") {
              slugManuallyEdited.current = false;
              setSlug(deriveSlug(next));
            }
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ws-slug">Slug</Label>
        <Input
          id="ws-slug"
          name="slug"
          required
          pattern="[a-z0-9\-]{2,40}"
          placeholder="production"
          value={slug}
          onChange={(e) => {
            const next = e.target.value;
            // An empty slug re-arms auto-population; any non-empty edit overrides it.
            slugManuallyEdited.current = next !== "";
            setSlug(next);
          }}
        />
        <p className="text-xs text-muted-foreground">
          Lowercase letters, digits, and hyphens. 2 to 40 chars.
        </p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
