"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface NewWorkspaceAction {
  (formData: FormData): Promise<{ ok: true; workspaceSlug: string } | { ok: false; error: string }>;
}

export function NewWorkspaceForm({ orgSlug, action }: { orgSlug: string; action: NewWorkspaceAction }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

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
      router.push(`/${orgSlug}/${res.workspaceSlug}`);
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="ws-name">Workspace name</Label>
        <Input id="ws-name" name="name" required maxLength={120} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ws-slug">Slug</Label>
        <Input id="ws-slug" name="slug" required pattern="[a-z0-9-]{2,40}" />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
