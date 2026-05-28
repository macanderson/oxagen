"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface NewTenantAction {
  (formData: FormData): Promise<{ ok: true; tenantSlug: string; workspaceSlug: string } | { ok: false; error: string }>;
}

export function NewTenantForm({ action }: { action: NewTenantAction }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

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
      router.push(`/${res.tenantSlug}/${res.workspaceSlug}`);
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Tenant name</Label>
        <Input id="name" name="name" required maxLength={120} placeholder="Acme Inc." />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="slug">Slug</Label>
        <Input id="slug" name="slug" required pattern="[a-z0-9-]{2,40}" placeholder="acme" />
        <p className="text-xs text-muted-foreground">Lowercase letters, digits, and hyphens. 2 to 40 chars.</p>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Creating…" : "Create tenant"}
      </Button>
    </form>
  );
}
