"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface NewOrgAction {
  (formData: FormData): Promise<{ ok: true; orgSlug: string; workspaceSlug: string } | { ok: false; error: string }>;
}

// Slug rules mirror the organization.create contract pattern: [a-z0-9-]{2,40}.
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

export function NewOrgForm({ action }: { action: NewOrgAction }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  // Once the user hand-edits the slug we stop overwriting it from name.
  const slugTouched = React.useRef(false);

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = await action(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.push(`/${res.orgSlug}/${res.workspaceSlug}`);
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Organization name</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={120}
          placeholder="Acme Inc."
          value={name}
          onChange={(e) => {
            const next = e.target.value;
            setName(next);
            if (!slugTouched.current) setSlug(deriveSlug(next));
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="slug">Slug</Label>
        <Input
          id="slug"
          name="slug"
          required
          pattern="[a-z0-9-]{2,40}"
          placeholder="acme"
          value={slug}
          onChange={(e) => {
            slugTouched.current = true;
            setSlug(e.target.value);
          }}
        />
        <p className="text-xs text-muted-foreground">Lowercase letters, digits, and hyphens. 2 to 40 chars.</p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </Button>
    </form>
  );
}
